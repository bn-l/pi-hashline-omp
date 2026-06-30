/**
 * Hashline edit tool — overrides pi's built-in edit.
 *
 * Accepts hashline patch language input:
 *   [path#A1B2]
 *   SWAP 2.=2:
 *   +new line content
 *
 * Validates snapshot tags, applies edits via the Patcher, and returns
 * compact results with fresh anchors for follow-up edits.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { dirname } from "node:path";
import {
	Patcher,
	Patch,
	buildCompactDiffPreview,
	computeFileHash,
	Filesystem,
	type BlockResolver,
	type FileOp,
	type InMemorySnapshotStore,
	type WriteResult,
} from "@oh-my-pi/hashline";
import { readFile, writeFile, rename, unlink, access, constants } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import * as Diff from "diff";
import { canonicalPath as resolveCanonicalPath, isPathInside, workspaceRoot } from "./paths";

/**
 * Disk-backed Filesystem, cwd-aware.
 * Extends the abstract Filesystem from @oh-my-pi/hashline.
 * Writes atomically via temp-file-then-rename.
 * Serializes mutations per canonical path to prevent races.
 */
class DiskFilesystem extends Filesystem {
	private readonly cwd: string;
	private readonly root: string;
	private static queues = new Map<string, Promise<void>>();

	constructor(cwd: string) {
		super();
		this.cwd = cwd;
		this.root = workspaceRoot(cwd);
	}

	canonicalPath(p: string): string {
		return resolveCanonicalPath(this.cwd, p);
	}

	async readText(p: string): Promise<string> {
		const cp = this.canonicalPath(p);
		try {
			return await readFile(cp, "utf-8");
		} catch (e) {
			console.error(`pi-hashline-omp: readText failed for ${cp}:`, e);
			throw e;
		}
	}

	async writeText(p: string, content: string): Promise<WriteResult> {
		const cp = this.canonicalPath(p);
		const op = async (): Promise<WriteResult> => {
			await this.writeAtomically(cp, content);
			return { text: content };
		};
		return this.enqueue(cp, op);
	}

	async delete(p: string): Promise<void> {
		const cp = this.canonicalPath(p);
		await this.enqueue(cp, async () => {
			try {
				await unlink(cp);
			} catch (e) {
				console.error(`pi-hashline-omp: delete failed for ${cp}:`, e);
				throw e;
			}
		});
	}

	async move(source: string, dest: string, content?: string): Promise<void> {
		const cs = this.canonicalPath(source);
		const cd = this.canonicalPath(dest);
		await this.enqueue([cs, cd], async () => {
			try {
				if (content === undefined) {
					await rename(cs, cd);
				} else {
					await this.writeAtomically(cd, content);
					await unlink(cs);
				}
			} catch (e) {
				console.error(`pi-hashline-omp: move failed for ${cs} -> ${cd}:`, e);
				throw e;
			}
		});
	}

	async exists(p: string): Promise<boolean> {
		const cp = this.canonicalPath(p);
		try {
			await access(cp, constants.R_OK);
			return true;
		} catch (e) {
			console.error(`pi-hashline-omp: exists check failed for ${cp}:`, e);
			return false;
		}
	}

	async preflightWrite(path: string, options?: { fileOp?: FileOp }): Promise<void> {
		const canonical = this.canonicalPath(path);
		this.assertInsideWorkspace(path, canonical, "Write denied");
		if (options?.fileOp?.kind === "move") {
			const destCanonical = this.canonicalPath(options.fileOp.dest);
			this.assertInsideWorkspace(options.fileOp.dest, destCanonical, "Move denied");
		}
	}

	allowTagPathRecovery(_authoredPath: string, resolvedPath: string): boolean {
		return isPathInside(this.root, this.canonicalPath(resolvedPath));
	}

	/** Serialize mutations to the same canonical path. */
	private enqueue<T>(paths: string | string[], fn: () => Promise<T>): Promise<T> {
		const canonicalPaths = [...new Set((Array.isArray(paths) ? paths : [paths]).map(p => this.canonicalPath(p)))].sort();
		const previous = Promise.all(canonicalPaths.map(path => DiskFilesystem.queues.get(path) ?? Promise.resolve()));
		const next = previous.then(fn);
		const tail = next.then(() => {}, () => {});
		for (const path of canonicalPaths) DiskFilesystem.queues.set(path, tail);
		void tail.then(() => {
			for (const path of canonicalPaths) {
				if (DiskFilesystem.queues.get(path) === tail) DiskFilesystem.queues.delete(path);
			}
		});
		return next;
	}

	private assertInsideWorkspace(authoredPath: string, canonical: string, action: string): void {
		if (!isPathInside(this.root, canonical)) {
			throw new Error(`${action}: ${authoredPath} is outside the workspace`);
		}
	}

	private async writeAtomically(path: string, content: string): Promise<void> {
		const dir = dirname(path);
		const tmp = `${dir}/.pi-hashline-${randomUUID()}.tmp`;
		try {
			await writeFile(tmp, content, "utf-8");
			await rename(tmp, path);
		} catch (e) {
			console.error(`pi-hashline-omp: atomic write failed for ${path}:`, e);
			try {
				await unlink(tmp);
			} catch (cleanupError) {
				console.error(`pi-hashline-omp: temp cleanup failed for ${tmp}:`, cleanupError);
			}
			throw e;
		}
	}
}

/** Convert Diff.structuredPatch hunks to hashline numbered-diff format: +N|text / -N|text /  N|text */
function toNumberedDiff(before: string, after: string): string {
	const patch = Diff.structuredPatch("file", "file", before, after, "", "", { context: 3 });
	const lines: string[] = [];
	for (const hunk of patch.hunks) {
		let oldLine = hunk.oldStart;
		let newLine = hunk.newStart;
		for (const line of hunk.lines) {
			const kind = line[0];
			const content = line.slice(1);
			if (kind === "+") { lines.push(`+${newLine}|${content}`); newLine++; }
			else if (kind === "-") { lines.push(`-${oldLine}|${content}`); oldLine++; }
			else { lines.push(` ${oldLine}|${content}`); oldLine++; newLine++; }
		}
	}
	return lines.join("\n");
}

/** Convert Diff.structuredPatch hunks to Pi TUI display-diff format: +N text / -N text /  N text */
function toDisplayDiff(before: string, after: string): string {
	const patch = Diff.structuredPatch("file", "file", before, after, "", "", { context: 3 });
	const lines: string[] = [];
	for (const hunk of patch.hunks) {
		let oldLine = hunk.oldStart;
		let newLine = hunk.newStart;
		for (const line of hunk.lines) {
			const kind = line[0];
			const content = line.slice(1);
			if (kind === "+") { lines.push(`+${newLine} ${content}`); newLine++; }
			else if (kind === "-") { lines.push(`-${oldLine} ${content}`); oldLine++; }
			else { lines.push(` ${oldLine} ${content}`); oldLine++; newLine++; }
		}
	}
	return lines.join("\n");
}

let noopCounts = new Map<string, { hash: string; count: number }>();
const NOOP_HARD_LIMIT = 3;
const mutationQueues = new Map<string, Promise<void>>();

function enqueueMutation<T>(paths: string[], fn: () => Promise<T>): Promise<T> {
	const canonicalPaths = [...new Set(paths)].sort();
	const previous = Promise.all(canonicalPaths.map(path => mutationQueues.get(path) ?? Promise.resolve()));
	const next = previous.then(fn);
	const tail = next.then(() => {}, () => {});
	for (const path of canonicalPaths) mutationQueues.set(path, tail);
	void tail.then(() => {
		for (const path of canonicalPaths) {
			if (mutationQueues.get(path) === tail) mutationQueues.delete(path);
		}
	});
	return next;
}

function collectMutationPaths(fs: DiskFilesystem, patch: Patch): string[] {
	const paths: string[] = [];
	for (const section of patch.sections) {
		paths.push(fs.canonicalPath(section.path));
		const fileOp = section.parse().fileOp;
		if (fileOp?.kind === "move") paths.push(fs.canonicalPath(fileOp.dest));
	}
	return paths;
}

export function registerEditTool(
	pi: ExtensionAPI,
	snapshots: InMemorySnapshotStore,
	blockResolver: BlockResolver,
) {
	pi.registerTool({
		name: "edit",
		label: "Edit",
		description:
			"Edit files using the hashline patch language. Input must start with [PATH#TAG] " +
			"section headers followed by SWAP/DEL/INS operations. " +
			"TAG is the 4-hex hash from your latest read/grep/edit output. " +
			"Operations: SWAP N.=M: replace lines, DEL N.=M delete lines, " +
			"INS.PRE/POST/HEAD/TAIL: insert, SWAP.BLK N:/DEL.BLK N: block ops, " +
			"REM delete file, MV dest move file.",
		parameters: Type.Object({
			input: Type.String({
				description:
					"Hashline patch: [PATH#TAG] section headers followed by " +
					"SWAP/DEL/INS/REM/MV operations with + body rows. " +
					"TAG must be the 4-hex snapshot tag from your latest read/grep/edit output.",
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const fs = new DiskFilesystem(ctx.cwd);
			const patcher = new Patcher({ fs, snapshots, blockResolver });

			// Parse the input into sections
			let patch: Patch;
			try {
				patch = Patch.parse(params.input, { cwd: ctx.cwd });
			} catch (e: any) {
				console.error("pi-hashline-omp: invalid hashline input:", e);
				return {
					content: [{ type: "text", text: `Invalid hashline input: ${e.message}` }],
					details: { error: e.message },
				};
			}

			if (patch.sections.length === 0) {
				return {
					content: [{ type: "text", text: "No valid hashline sections found in input. Each section must start with [PATH#TAG]." }],
					details: {},
				};
			}

			// Apply all sections
			try {
				const result = await enqueueMutation(collectMutationPaths(fs, patch), () => patcher.apply(patch));

				// Check for no-ops
				const noopSections = result.sections.filter(s => s.op === "noop");
				if (noopSections.length === result.sections.length) {
					// All no-ops — check loop guard
					const firstPath = noopSections[0]!.canonicalPath;
					const inputHash = computeFileHash(params.input);
					const record = noopCounts.get(firstPath);
					if (record && record.hash === inputHash) {
						record.count++;
						if (record.count >= NOOP_HARD_LIMIT) {
							noopCounts.delete(firstPath);
							return {
								content: [{
									type: "text",
									text: `STOP. Edits to ${noopSections[0]!.path} have been a byte-identical no-op ${NOOP_HARD_LIMIT} times in a row. The file already contains your intended changes, or your anchor is wrong. Re-read the file before issuing another edit.`,
								}],
								details: {},
							};
						}
					} else {
						noopCounts.set(firstPath, { hash: inputHash, count: 1 });
					}
					return {
						content: [{
							type: "text",
							text: `Edits to ${noopSections[0]!.path} produced no change — your body rows are byte-identical to the file. Re-read the file before issuing another edit. Do NOT widen the payload.`,
						}],
						details: {},
					};
				}

				// Reset noop counts for paths that changed
				for (const section of result.sections) {
					if (section.op !== "noop") {
						noopCounts.delete(section.canonicalPath);
					}
				}

				// Build output: content (model-facing anchors) + details.diff (TUI display)
				const parts: string[] = [];
				const diffs: string[] = [];
				let firstChangedLine: number | undefined;
				for (const section of result.sections) {
					if (section.op === "delete") {
						parts.push(`Deleted ${section.path}`);
						continue;
					}
					if (section.op === "noop") continue;

					// Generate proper numbered diff for compact preview (model-facing)
					const numberedDiff = toNumberedDiff(section.before, section.after);
					const compact = buildCompactDiffPreview(numberedDiff);

					// Generate display diff for TUI
					const displayDiff = toDisplayDiff(section.before, section.after);
					if (displayDiff) diffs.push(displayDiff);
					if (firstChangedLine === undefined && compact.addedLines + compact.removedLines > 0) {
						firstChangedLine = result.sections.find(s => s.op !== "noop" && s.op !== "delete")?.firstChangedLine;
					}

					const blockResolutions = section.blockResolutions
						?.map(r => {
							const op = r.op === "delete" ? "DEL.BLK" : r.op === "insert_after" ? "INS.BLK.POST" : "SWAP.BLK";
							return `${op} ${r.anchorLine} → resolved lines ${r.start}-${r.end}`;
						})
						.join("\n") ?? "";

					const warningsBlock = section.warnings.length > 0
						? `\nWarnings:\n${section.warnings.join("\n")}`
						: "";

					const moveBlock = section.moveDest ? `\nMoved to ${section.moveDest}` : "";

					// Content: header + block resolutions + compact preview (model anchoring)
					const contentBlock = compact.preview
						? `${section.header}${blockResolutions ? "\n" + blockResolutions : ""}${moveBlock}${warningsBlock}\n${compact.preview}`
						: `${section.header}${blockResolutions ? "\n" + blockResolutions : ""}${moveBlock}${warningsBlock}`;
					parts.push(contentBlock);
				}

				const contentText = parts.join("\n\n") || "No changes made.";
				return {
					content: [{ type: "text", text: contentText }],
					details: {
						diff: diffs.join("\n"),
						firstChangedLine,
					},
				};
			} catch (e: any) {
				const message = e.message ?? String(e);
				console.error("pi-hashline-omp: edit failed:", e);
				// Detect mismatch errors and provide helpful guidance
				if (message.includes("hash") || message.includes("snapshot") || message.includes("tag")) {
					return {
						content: [{
							type: "text",
							text: `Edit failed — the file has changed since your last read:\n${message}\n\nRe-read the file to get fresh anchors, then re-issue your edit.`,
						}],
						details: { error: message },
					};
				}
				return {
					content: [{ type: "text", text: `Edit failed: ${message}` }],
					details: { error: message },
				};
			}
		},
	});
}
