/**
 * Integration tests for pi-hashline-omp.
 *
 * Tests the core hashline workflow without needing a full pi agent session:
 *   - Read → returns hashline-formatted output with valid tag
 *   - Edit → accepts hashline input and applies patches
 *   - Block resolver → resolves brace, python, shell, markdown blocks
 *   - Stale anchor → detects and rejects edits when file changed
 *   - Snapshot store → records and retrieves file snapshots
 */

import { describe, it, expect } from "vitest";
import {
	computeFileHash,
	formatHashlineHeader,
	Patch,
	Patcher,
	InMemoryFilesystem,
	InMemorySnapshotStore,
	MismatchError,
} from "@oh-my-pi/hashline";
import { createBlockResolver } from "../src/block-resolver";
import { createSnapshotStore } from "../src/snapshot-store";

// ---------- Block Resolver Tests ----------

describe("block resolver", () => {
	const resolver = createBlockResolver();

	describe("brace languages", () => {
		it("resolves function block in TypeScript", () => {
			const code = "const x = 1;\nfunction hello() {\n  return 1;\n}\nconst y = 2;\n";
			const result = resolver({ path: "test.ts", text: code, line: 2 });
			expect(result).not.toBeNull();
			expect(result!.start).toBe(2);
			expect(result!.end).toBe(4);
		});

		it("resolves nested blocks correctly", () => {
			const code = "function outer() {\n  if (a) {\n    g();\n  }\n}\n";
			const result = resolver({ path: "test.ts", text: code, line: 2 });
			expect(result).not.toBeNull();
			expect(result!.start).toBe(2);
			expect(result!.end).toBe(4);
		});

		it("returns null for continuation line", () => {
			const code = "foo(\n  a,\n  b,\n);\n";
			const result = resolver({ path: "test.ts", text: code, line: 4 });
			expect(result).toBeNull();
		});

		it("resolves class block in JavaScript", () => {
			const code = "class Foo {\n  bar() {}\n}\n";
			const result = resolver({ path: "test.js", text: code, line: 1 });
			expect(result).not.toBeNull();
			expect(result!.start).toBe(1);
			expect(result!.end).toBe(3);
		});

		it("resolves block in Rust", () => {
			const code = "struct A;\nstruct B {\n    x: u32,\n}\n";
			const result = resolver({ path: "test.rs", text: code, line: 2 });
			expect(result).not.toBeNull();
			expect(result!.start).toBe(2);
			expect(result!.end).toBe(4);
		});
	});

	describe("python", () => {
		it("resolves function block", () => {
			const code = "x = 1\ndef greet():\n    return 1";
			const result = resolver({ path: "test.py", text: code, line: 2 });
			expect(result).not.toBeNull();
			expect(result!.start).toBe(2);
			expect(result!.end).toBe(3);
		});

		it("returns null for line without colon", () => {
			const code = "x = 1\ny = 2\n";
			const result = resolver({ path: "test.py", text: code, line: 1 });
			expect(result).toBeNull();
		});

		it("resolves nested blocks (inner for)", () => {
			const code = "def f(xs):\n    total = 0\n    for x in xs:\n        total += x\n    return total\n";
			const result = resolver({ path: "test.py", text: code, line: 3 });
			expect(result).not.toBeNull();
			expect(result!.start).toBe(3);
			expect(result!.end).toBe(4);
		});
	});

	describe("shell", () => {
		it("resolves if/fi block", () => {
			const code = "if [[ -f file ]]; then\n  echo ok\nfi\n";
			const result = resolver({ path: "test.sh", text: code, line: 1 });
			expect(result).not.toBeNull();
			expect(result!.start).toBe(1);
			expect(result!.end).toBe(3);
		});
	});

	describe("markdown", () => {
		it("resolves heading section", () => {
			const code = "# H1\nintro\n\n## H2\nbody\n\n# Next H1\n";
			const result = resolver({ path: "test.md", text: code, line: 4 });
			expect(result).not.toBeNull();
			expect(result!.start).toBe(4);
			expect(result!.end).toBe(6);
		});

		it("returns null for non-heading line", () => {
			const code = "# H1\nplain text\n";
			const result = resolver({ path: "test.md", text: code, line: 2 });
			expect(result).toBeNull();
		});
	});

	describe("unsupported languages", () => {
		it("returns null for unknown extension", () => {
			const result = resolver({ path: "test.xyz", text: "anything", line: 1 });
			expect(result).toBeNull();
		});
	});
});

// ---------- Snapshot Store Tests ----------

describe("snapshot store", () => {
	it("records and retrieves snapshots", () => {
		const store = createSnapshotStore();
		const tag = store.record("/tmp/test.ts", "const x = 1;\n");
		expect(tag).toMatch(/^[0-9A-F]{4}$/);
		const snapshot = store.byHash("/tmp/test.ts", tag);
		expect(snapshot).not.toBeNull();
		expect(snapshot!.text).toBe("const x = 1;\n");
	});

	it("returns null for unknown hash", () => {
		const store = createSnapshotStore();
		const snapshot = store.byHash("/tmp/test.ts", "FFFF");
		expect(snapshot).toBeNull();
	});
});

// ---------- Hashline Engine Tests ----------

describe("hashline engine", () => {
	it("parses a simple SWAP patch", () => {
		const input = "[test.ts#0001]\nSWAP 2.=2:\n+const x = 1;\n";
		const patch = Patch.parse(input, { cwd: "/tmp" });
		expect(patch.sections.length).toBe(1);
		expect(patch.sections[0].path).toBe("test.ts");
		const parsed = patch.sections[0].parse();
		expect(parsed.edits.length).toBeGreaterThan(0);
	});

	it("parses a multi-section patch", () => {
		const input = "[a.ts#0001]\nSWAP 1.=1:\n+// header\n[b.ts#0001]\nDEL 20\n";
		const patch = Patch.parse(input, { cwd: "/tmp" });
		expect(patch.sections.length).toBe(2);
		expect(patch.sections[0].path).toBe("a.ts");
		expect(patch.sections[1].path).toBe("b.ts");
	});

	it("parses DEL, INS ops in one section", () => {
		const input = "[f.ts#0001]\nDEL 3.=5\nINS.POST 7:\n+new line\n";
		const patch = Patch.parse(input, { cwd: "/tmp" });
		const parsed = patch.sections[0].parse();
		expect(parsed.edits.length).toBeGreaterThan(0);
	});

	it("parses REM file-level op", () => {
		const input = "[f.ts#0001]\nREM\n";
		const patch = Patch.parse(input, { cwd: "/tmp" });
		const parsed = patch.sections[0].parse();
		expect(parsed.fileOp).toBeDefined();
		expect(parsed.fileOp!.kind).toBe("rem");
	});

	it("parses MV file-level op", () => {
		const input = "[f.ts#0001]\nMV dest.ts\n";
		const patch = Patch.parse(input, { cwd: "/tmp" });
		const parsed = patch.sections[0].parse();
		expect(parsed.fileOp).toBeDefined();
		expect(parsed.fileOp!.kind).toBe("move");
	});

	it("patches via Patcher with block resolver", async () => {
		const fs = new InMemoryFilesystem();
		const store = new InMemorySnapshotStore();
		const resolver = createBlockResolver();
		const patcher = new Patcher({ fs, snapshots: store, blockResolver: resolver });

		// Write initial file
		await fs.writeText("/tmp/test.ts", "function hello() {\n  return 1;\n}\nconsole.log(hello());\n");
		const tag = store.record("/tmp/test.ts", "function hello() {\n  return 1;\n}\nconsole.log(hello());\n");

		// Apply a block-level edit
		const input = `[/tmp/test.ts#${tag}]\nSWAP.BLK 1:\n+function hello() {\n+  return 2;\n+}\n`;
		const result = await patcher.apply(Patch.parse(input, { cwd: "/" }));

		expect(result.sections.length).toBe(1);
		expect(result.sections[0].after).toBe("function hello() {\n  return 2;\n}\nconsole.log(hello());\n");
	});

	it("rejects stale anchor (hash mismatch)", async () => {
		const fs = new InMemoryFilesystem();
		const store = new InMemorySnapshotStore();
		const patcher = new Patcher({ fs, snapshots: store, blockResolver: createBlockResolver() });

		// Write and snapshot file
		const original = "const x = 1;\nconst y = 2;\n";
		await fs.writeText("/tmp/test.ts", original);
		const tag = store.record("/tmp/test.ts", original);

		// Change file behind the scenes
		await fs.writeText("/tmp/test.ts", "const x = 999;\nconst y = 2;\n");

		// Try to edit with stale tag
		const input = `[/tmp/test.ts#${tag}]\nSWAP 1.=1:\n+const x = 100;\n`;
		await expect(patcher.apply(Patch.parse(input, { cwd: "/" }))).rejects.toThrow(MismatchError);
	});

	it("handles DEL operation", async () => {
		const fs = new InMemoryFilesystem();
		const store = new InMemorySnapshotStore();
		const patcher = new Patcher({ fs, snapshots: store });

		const original = "line 1\nline 2\nline 3\n";
		await fs.writeText("/tmp/test.ts", original);
		const tag = store.record("/tmp/test.ts", original);

		const input = `[/tmp/test.ts#${tag}]\nDEL 2\n`;
		const result = await patcher.apply(Patch.parse(input, { cwd: "/" }));

		expect(result.sections[0].after).toBe("line 1\nline 3\n");
	});

	it("handles INS.HEAD and INS.TAIL", async () => {
		const fs = new InMemoryFilesystem();
		const store = new InMemorySnapshotStore();
		const patcher = new Patcher({ fs, snapshots: store });

		const original = "line 1\nline 2\n";
		await fs.writeText("/tmp/test.ts", original);
		const tag = store.record("/tmp/test.ts", original);

		const input = `[/tmp/test.ts#${tag}]\nINS.HEAD:\n+// header\nINS.TAIL:\n+// footer\n`;
		const result = await patcher.apply(Patch.parse(input, { cwd: "/" }));

		expect(result.sections[0].after).toBe("// header\nline 1\nline 2\n// footer\n");
	});

	it("handles REM operation", async () => {
		const fs = new InMemoryFilesystem();
		const store = new InMemorySnapshotStore();
		const patcher = new Patcher({ fs, snapshots: store });

		const original = "delete me\n";
		await fs.writeText("/tmp/test.ts", original);
		const tag = store.record("/tmp/test.ts", original);

		const input = `[/tmp/test.ts#${tag}]\nREM\n`;
		const result = await patcher.apply(Patch.parse(input, { cwd: "/" }));

		expect(result.sections[0].op).toBe("delete");
	});
});

// ---------- Format Tests ----------

describe("format", () => {
	it("computeFileHash is deterministic", () => {
		const h1 = computeFileHash("hello\n");
		const h2 = computeFileHash("hello\n");
		expect(h1).toBe(h2);
		expect(h1).toMatch(/^[0-9A-F]{4}$/);
	});

	it("computeFileHash differs for different content", () => {
		const h1 = computeFileHash("hello\n");
		const h2 = computeFileHash("world\n");
		expect(h1).not.toBe(h2);
	});

	it("formatHashlineHeader produces valid header", () => {
		const h = formatHashlineHeader("test.ts", "A1B2");
		expect(h).toBe("[test.ts#A1B2]");
	});
});
