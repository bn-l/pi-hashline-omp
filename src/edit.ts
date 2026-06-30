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
import { resolve, dirname } from "node:path";
import {
	Patcher,
	Patch,
	buildCompactDiffPreview,
	computeFileHash,
	Filesystem,
	type BlockResolver,
	type InMemorySnapshotStore,
	type WriteResult,
} from "@oh-my-pi/hashline";
import { readFile, writeFile, rename, unlink, access, constants } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import * as Diff from "diff";

/**
 * Disk-backed Filesystem, cwd-aware.
 * Extends the abstract Filesystem from @oh-my-pi/hashline.
 * Writes atomically via temp-file-then-rename.
 * Serializes mutations per canonical path to prevent races.
 */
class DiskFilesystem extends Filesystem {
	private cwd: string;
	private static queues = new Map<string, Promise<void>>();

	constructor(cwd: string) {
		super();
		this.cwd = cwd;
	}

	canonicalPath(p: string): string {
		try {
			return resolve(this.cwd, p);
		} catch (e) {
			console.error("pi-hashline-omp: canonicalPath resolve error:", e);
			return p;
		}
	}

	async readText(p: string): Promise<string> {
		return readFile(this.canonicalPath(p), "utf-8");
	}

	async writeText(p: string, content: string): Promise<WriteResult> {
		const cp = this.canonicalPath(p);
		const op = async (): Promise<WriteResult> => {
			const dir = dirname(cp);
			const tmp = `${dir}/.pi-hashline-${randomUUID()}.tmp`;
			try {
				await writeFile(tmp, content, "utf-8");
				await rename(tmp, cp);
			} catch (e) {
				try { await unlink(tmp); } catch (e) { console.error("pi-hashline-omp: unlink temp error:", e); }
				throw e;
			}
			return { text: content };
		};
		return this.enqueue(cp, op);
	}

	async delete(p: string): Promise<void> {
		const cp = this.canonicalPath(p);
		await this.enqueue(cp, async () => { await unlink(cp); });
	}

	async move(source: string, dest: string, content: string): Promise<void> {
		const cs = this.canonicalPath(source);
		const cd = this.canonicalPath(dest);
		await this.enqueue(cs, async () => {
			await writeFile(cd, content, "utf-8");
			await unlink(cs);
		});
	}

	async exists(p: string): Promise<boolean> {
		try {
			await access(this.canonicalPath(p), constants.R_OK);
			return true;
		} catch {
			return false;
		}
	}



	async preflightWrite(path: string, _options?: { fileOp?: { kind: string } }): Promise<void> {
		// Verify path is within the workspace cwd
		const canonical = this.canonicalPath(path);
		if (!canonical.startsWith(resolve(this.cwd))) {
			throw new Error(`Write denied: ${path} is outside the workspace`);
		}
	}

	allowTagPathRecovery(_authoredPath: string, resolvedPath: string): boolean {
		// Only allow recovery to paths within the workspace
		return resolvedPath.startsWith(resolve(this.cwd));
	}

	/** Serialize mutations to the same canonical path. */
	private enqueue<T>(path: string, fn: () => Promise<T>): Promise<T> {
		const canonical = this.canonicalPath(path);
		const prev = DiskFilesystem.queues.get(canonical) ?? Promise.resolve();
		const next = prev.then(fn, fn); // run even if previous rejected
		DiskFilesystem.queues.set(canonical, next.then(() => {}, () => {}));
		return next;
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
				const result = await patcher.apply(patch);

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
