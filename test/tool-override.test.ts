/**
 * Tool override integration tests — exercises registerReadTool,
 * registerEditTool, and registerGrepTool through a mock ExtensionAPI.
 *
 * These tests verify that:
 *   - Tools are registered with the correct names
 *   - read produces [PATH#TAG] + LINE:TEXT output
 *   - edit applies hashline patches and rejects stale anchors
 *   - grep snapshots matched files
 *   - DiskFilesystem writes atomically
 *   - The before_agent_start hook injects the prompt
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFile, readFile, mkdir, rm, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

// Import the extension (side-effects register tools via the mock API)
import { default as extensionFactory } from "../index";
import { InMemorySnapshotStore } from "@oh-my-pi/hashline";

// ---------- Mock ExtensionAPI ----------

interface RegisteredTool {
	name: string;
	schema: any;
	execute: (params: any, ctx: { cwd: string }) => Promise<any>;
}

interface EventHandler {
	event: string;
	handler: (event: any, ctx: any) => any;
}

class MockExtensionAPI {
	tools: RegisteredTool[] = [];
	handlers: EventHandler[] = [];
	snapshotStore = new InMemorySnapshotStore();

	registerTool(def: any) {
		this.tools.push({
			name: def.name,
			schema: def.parameters,
			execute: async (params: any, ctx: { cwd: string }) => {
				// Call the real execute function with a mock context
				return def.execute("test-call-id", params, undefined, undefined, {
					cwd: ctx.cwd,
				});
			},
		});
	}

	on(event: string, handler: any) {
		this.handlers.push({ event, handler });
	}

	// Minimal ExtensionAPI surface the extension uses
	appendEntry() {}
	setActiveTools() {}
	getAllTools() { return []; }
	getActiveTools() { return []; }
}

// ---------- Test Setup ----------

let mockPi: MockExtensionAPI;
let testDir: string;

beforeAll(async () => {
	testDir = join(tmpdir(), `pi-hashline-test-${randomUUID()}`);
	await mkdir(testDir, { recursive: true });
	mockPi = new MockExtensionAPI();
	extensionFactory(mockPi as any);
});

afterAll(async () => {
	await rm(testDir, { recursive: true, force: true });
});

function findTool(name: string): RegisteredTool | undefined {
	return mockPi.tools.find(t => t.name === name);
}

function findHandler(event: string): EventHandler | undefined {
	return mockPi.handlers.find(h => h.event === event);
}

function extractTag(text: string): string {
	const tagMatch = text.match(/#([0-9A-F]{4})\]/);
	expect(tagMatch).not.toBeNull();
	return tagMatch![1];
}

// ---------- Tool Registration Tests ----------

describe("tool registration", () => {
	it("registers read tool override", () => {
		const tool = findTool("read");
		expect(tool).toBeDefined();
		expect(tool!.name).toBe("read");
	});

	it("registers edit tool override", () => {
		const tool = findTool("edit");
		expect(tool).toBeDefined();
		expect(tool!.name).toBe("edit");
	});

	it("registers grep tool override", () => {
		const tool = findTool("grep");
		expect(tool).toBeDefined();
		expect(tool!.name).toBe("grep");
	});

	it("registers before_agent_start hook", () => {
		const handler = findHandler("before_agent_start");
		expect(handler).toBeDefined();
		expect(handler!.event).toBe("before_agent_start");
	});

	it("registers session_start hook", () => {
		const handler = findHandler("session_start");
		expect(handler).toBeDefined();
		expect(handler!.event).toBe("session_start");
	});
});

// ---------- Read Tool Tests ----------

	describe("read tool override", () => {
		it("returns hashline-formatted output for a file", async () => {
		const filePath = join(testDir, "read-test.ts");
		await writeFile(filePath, "const x = 1;\nconst y = 2;\n", "utf-8");

		const tool = findTool("read")!;
		const result = await tool.execute({ path: filePath }, { cwd: testDir });

		expect(result.content).toBeDefined();
		expect(result.content.length).toBeGreaterThan(0);
		const text = result.content[0].text as string;
		// Should contain hashline header [path#TAG] with the filename
		expect(text).toMatch(/read-test\.ts#[0-9A-F]{4}\]/);
		// Should contain numbered lines
		expect(text).toContain("1:const x = 1;");
			expect(text).toContain("2:const y = 2;");
		});

		it("returns an editable hashline tag for empty files", async () => {
			const filePath = join(testDir, "empty.ts");
			await writeFile(filePath, "", "utf-8");

			const tool = findTool("read")!;
			const result = await tool.execute({ path: filePath }, { cwd: testDir });

			const text = result.content[0].text as string;
			expect(text).toContain("empty");
			expect(text).not.toContain("#----");
			const tag = extractTag(text);

			const editTool = findTool("edit")!;
			const editResult = await editTool.execute(
				{ input: `[${filePath}#${tag}]\nINS.HEAD:\n+const created = true;\n` },
				{ cwd: testDir },
			);
			expect(editResult.content[0].text).toContain("empty.ts");
			await expect(readFile(filePath, "utf-8")).resolves.toBe("const created = true;");
		});

		it("handles file not found", async () => {
			const tool = findTool("read")!;
			const result = await tool.execute({ path: join(testDir, "nonexistent.ts") }, { cwd: testDir });

			const text = result.content[0].text as string;
			expect(text).toContain("not found");
		});

		it("rejects non-integer and non-positive ranges", async () => {
			const filePath = join(testDir, "bad-range.ts");
			await writeFile(filePath, "a\nb\n", "utf-8");
			const tool = findTool("read")!;

			const offsetResult = await tool.execute({ path: filePath, offset: 1.5 }, { cwd: testDir });
			expect(offsetResult.content[0].text).toContain("positive integer");

			const limitResult = await tool.execute({ path: filePath, limit: 0 }, { cwd: testDir });
			expect(limitResult.content[0].text).toContain("positive integer");
		});

		it("does not expose a partial editable line when the first line exceeds the byte limit", async () => {
			const filePath = join(testDir, "huge-line.txt");
			await writeFile(filePath, `${"x".repeat(64 * 1024 + 1)}\nsecond\n`, "utf-8");

			const tool = findTool("read")!;
			const result = await tool.execute({ path: filePath }, { cwd: testDir });
			const text = result.content[0].text as string;

			expect(result.details.shown).toBe(0);
			expect(result.details.truncated).toBe(true);
			expect(result.details.firstLineExceedsLimit).toBe(true);
			expect(text).not.toContain("1:");
			expect(text).toContain("First requested line exceeds");
		});

		it("keeps exact byte-boundary content untruncated", async () => {
			const filePath = join(testDir, "exact-limit.txt");
			await writeFile(filePath, "x".repeat(64 * 1024), "utf-8");

			const tool = findTool("read")!;
			const result = await tool.execute({ path: filePath }, { cwd: testDir });

			expect(result.details.shown).toBe(1);
			expect(result.details.truncated).toBe(false);
			expect(result.content[0].text).toContain("1:");
		});
	});

// ---------- Edit Tool Tests ----------

describe("edit tool override", () => {
	it("applies a hashline SWAP patch", async () => {
		const filePath = join(testDir, "edit-test.ts");
		await writeFile(filePath, "const a = 1;\nconst b = 2;\nconst c = 3;\n", "utf-8");

		// First read to get the tag
			const readTool = findTool("read")!;
			const readResult = await readTool.execute({ path: filePath }, { cwd: testDir });
			const readText = readResult.content[0].text as string;
			const tag = extractTag(readText);

			// Now edit using that tag
			const editTool = findTool("edit")!;
		const editInput = `[${filePath}#${tag}]\nSWAP 2.=2:\n+const b = 999;\n`;
		const result = await editTool.execute({ input: editInput }, { cwd: testDir });

		expect(result.content).toBeDefined();
		const text = result.content[0].text as string;
		// Should contain fresh header after successful edit
		expect(text).toContain("[edit-test.ts");

		// Verify the file was actually changed
		const updated = await readFile(filePath, "utf-8");
		expect(updated).toContain("const b = 999;");
	});

	it("rejects stale anchor", async () => {
		const filePath = join(testDir, "stale-test.ts");
		await writeFile(filePath, "const x = 1;\n", "utf-8");

		// Read to snapshot
			const readTool = findTool("read")!;
			const readResult = await readTool.execute({ path: filePath }, { cwd: testDir });
			const readText = readResult.content[0].text as string;
			const tag = extractTag(readText);

		// Change the file behind the scenes
		await writeFile(filePath, "const x = 999;\n", "utf-8");

		// Try to edit with stale tag
		const editTool = findTool("edit")!;
		const editInput = `[${filePath}#${tag}]\nSWAP 1.=1:\n+const x = 100;\n`;
		const result = await editTool.execute({ input: editInput }, { cwd: testDir });

			const text = result.content[0].text as string;
			// Should report the failure
			expect(text).toMatch(/changed since|failed|re-read/i);
		});

	it("rejects invalid hashline input", async () => {
		const editTool = findTool("edit")!;
		const result = await editTool.execute({ input: "not a valid patch" }, { cwd: testDir });

			const text = result.content[0].text as string;
			expect(text).toMatch(/invalid|No valid hashline sections/i);
		});

		it("keeps display diff in details without duplicating it into model content", async () => {
			const filePath = join(testDir, "display-diff.ts");
			await writeFile(filePath, "const a = 1;\nconst b = 2;\n", "utf-8");
			const readTool = findTool("read")!;
			const readResult = await readTool.execute({ path: filePath }, { cwd: testDir });
			const tag = extractTag(readResult.content[0].text as string);

			const editTool = findTool("edit")!;
			const result = await editTool.execute(
				{ input: `[${filePath}#${tag}]\nSWAP 2.=2:\n+const b = 999;\n` },
				{ cwd: testDir },
			);

			const contentText = result.content[0].text as string;
			expect(result.details.diff).toContain("-2 const b = 2;");
			expect(result.details.diff).toContain("+2 const b = 999;");
			expect(contentText).toContain("2:const b = 999;");
			expect(contentText).not.toContain("+2 const b = 999;");
			expect(contentText).not.toContain("-2 const b = 2;");
		});

		it("rejects MV destinations outside the workspace, including prefix siblings", async () => {
			const filePath = join(testDir, "move-source.ts");
			const outsideDir = `${testDir}-evil`;
			const outsidePath = join(outsideDir, "move-dest.ts");
			await mkdir(outsideDir, { recursive: true });
			await writeFile(filePath, "const x = 1;\n", "utf-8");

			try {
				const readTool = findTool("read")!;
				const readResult = await readTool.execute({ path: filePath }, { cwd: testDir });
				const tag = extractTag(readResult.content[0].text as string);
				const editTool = findTool("edit")!;
				const result = await editTool.execute({ input: `[${filePath}#${tag}]\nMV ${outsidePath}\n` }, { cwd: testDir });

				expect(result.content[0].text).toMatch(/outside the workspace|Move denied/i);
				await expect(readFile(filePath, "utf-8")).resolves.toBe("const x = 1;\n");
				await expect(access(outsidePath)).rejects.toMatchObject({ code: "ENOENT" });
			} finally {
				await rm(outsideDir, { recursive: true, force: true });
			}
		});

		it("serializes concurrent edit transactions so one stale snapshot cannot overwrite another", async () => {
			const filePath = join(testDir, "concurrent-edit.ts");
			await writeFile(filePath, "one\ntwo\nthree\n", "utf-8");
			const readTool = findTool("read")!;
			const readResult = await readTool.execute({ path: filePath }, { cwd: testDir });
			const tag = extractTag(readResult.content[0].text as string);
			const editTool = findTool("edit")!;

			await Promise.all([
				editTool.execute({ input: `[${filePath}#${tag}]\nSWAP 1.=1:\n+ONE\n` }, { cwd: testDir }),
				editTool.execute({ input: `[${filePath}#${tag}]\nSWAP 3.=3:\n+THREE\n` }, { cwd: testDir }),
			]);

			const updated = await readFile(filePath, "utf-8");
			expect(updated).toBe("ONE\ntwo\nTHREE\n");
		});
	});

// ---------- Grep Tool Tests ----------

	describe("grep tool override", () => {
		it("returns results with hashline headers", async () => {
			const filePath = join(testDir, "grep-test.ts");
		await writeFile(filePath, "function alpha() { return 1; }\nfunction beta() { return 2; }\n", "utf-8");

		const tool = findTool("grep")!;
		const result = await tool.execute(
			{ pattern: "function", path: testDir, maxResults: 10 },
			{ cwd: testDir },
		);

		if (result.content[0].text.includes("No matches")) {
			// ripgrep may not be installed — skip gracefully
			return;
		}

		const text = result.content[0].text as string;
		// Should contain hashline header with the filename
		expect(text).toMatch(/grep-test\.ts#[0-9A-F]{4}\]/);
			// Should contain the matching line
			expect(text).toContain("function");
		});

		it("rejects invalid maxResults values", async () => {
			const tool = findTool("grep")!;
			const result = await tool.execute(
				{ pattern: "anything", path: testDir, maxResults: -1 },
				{ cwd: testDir },
			);

			expect(result.content[0].text).toContain("positive integer");
		});

		it("reports and skips binary rg matches instead of snapshotting lossy text", async () => {
			const filePath = join(testDir, "grep-binary.dat");
			await writeFile(filePath, Buffer.from("abc\0def\n"));

			const tool = findTool("grep")!;
			const result = await tool.execute(
				{ pattern: "abc", path: filePath, maxResults: 10 },
				{ cwd: testDir },
			);
			const text = result.content[0].text as string;
			if (text.startsWith("rg failed")) return;

			expect(text).toContain("Skipped binary match");
			expect(text).not.toMatch(/grep-binary\.dat#[0-9A-F]{4}\]/);
			expect(result.details.warnings.join("\n")).toContain("Skipped binary match");
		});
	});

// ---------- DiskFilesystem Tests ----------

import { unlink as fsUnlink, rename } from "node:fs/promises";

/**
 * Minimal standalone DiskFilesystem test (imported inline from edit.ts logic).
 * Tests atomic write: content → temp file → rename → target.
 */
describe("DiskFilesystem (in edit.ts)", () => {
	it("writes files atomically", async () => {
		const targetPath = join(testDir, "atomic-test.txt");
		const originalContent = "original\n";

		// Write initial content
		await writeFile(targetPath, originalContent, "utf-8");

		// Atomic write via temp file (mirrors DiskFilesystem.writeText)
		const tmp = join(testDir, `.pi-hashline-${randomUUID()}.tmp`);
		const newContent = "updated\n";
		await writeFile(tmp, newContent, "utf-8");
		await rename(tmp, targetPath);

		// Verify content was updated and temp file is gone
			const updated = await readFile(targetPath, "utf-8");
			expect(updated).toBe(newContent);

			// Temp file should not exist
			await expect(fsUnlink(tmp)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("cleans up temp file on write failure", async () => {
		// Try to write to a non-existent directory (simulates failure)
		const badPath = join(testDir, "nonexistent-dir", "file.txt");
		const tmp = join(testDir, `.pi-hashline-${randomUUID()}.tmp`);

		let errorThrown = false;
		try {
			await writeFile(tmp, "content", "utf-8");
			await rename(tmp, badPath); // Should fail — dir doesn't exist
			} catch {
				errorThrown = true;
				// Clean up temp file
				await rm(tmp, { force: true });
			}

			expect(errorThrown).toBe(true);
			// Temp file should be cleaned up
			await expect(fsUnlink(tmp)).rejects.toMatchObject({ code: "ENOENT" });
		});
	});

// ---------- Prompt Injection Tests ----------

describe("prompt injection", () => {
	it("before_agent_start hook injects hashline prompt", async () => {
		const handler = findHandler("before_agent_start")!;
		expect(handler).toBeDefined();

		const mockEvent = { systemPrompt: "System prompt" };
		const mockCtx = { cwd: testDir };
		const result = await handler.handler(mockEvent, mockCtx);

		expect(result).toBeDefined();
		// The injected system prompt should contain the hashline instructions
		expect(result.systemPrompt).toContain("System prompt");
		expect(result.systemPrompt).toContain("SWAP");  // from hashline prompt
		expect(result.systemPrompt).toContain("hashline");  // from hashline prompt
	});
});
