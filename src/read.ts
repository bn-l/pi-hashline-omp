/**
 * Hashline read tool — overrides pi's built-in read.
 *
 * Reads a file and returns it in hashline format:
 *   [path#A1B2]
 *   1:line one
 *   2:line two
 *
 * The 4-hex #TAG is a full-file content hash. The model uses this tag
 * in subsequent edit calls to anchor edits to a specific file version.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import {
	formatHashlineHeader,
	formatNumberedLines,
	type InMemorySnapshotStore,
} from "@oh-my-pi/hashline";
import { canonicalPath } from "./paths";

// Image extensions that should fall through to pi's built-in image handling
const IMAGE_MIME: Record<string, string> = {
	".jpg": "image/jpeg", ".jpeg": "image/jpeg",
	".png": "image/png",
	".gif": "image/gif",
	".webp": "image/webp",
	".bmp": "image/bmp",
	".svg": "image/svg+xml",
};

function detectImageMimeType(p: string): string | undefined {
	const ext = p.split(".").pop()?.toLowerCase();
	if (!ext) return undefined;
	return IMAGE_MIME[`.${ext}`];
}

/** Pi's built-in read limits: 2000 lines, 64KB */
const MAX_LINES = 2000;
const MAX_BYTES = 64 * 1024;

function validatePositiveInteger(name: string, value: number | undefined): string | undefined {
	if (value === undefined) return undefined;
	if (!Number.isInteger(value) || value < 1) return `${name} ${value} is invalid (must be a positive integer)`;
	return undefined;
}

function splitFileLines(content: string): string[] {
	const lines = content.split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

function truncateWholeLines(lines: string[]): { output: string; shownLineCount: number; truncated: boolean; firstLineExceedsLimit: boolean } {
	const joined = lines.join("\n");
	if (Buffer.byteLength(joined, "utf-8") <= MAX_BYTES) {
		return { output: joined, shownLineCount: lines.length, truncated: false, firstLineExceedsLimit: false };
	}

	let lo = 0;
	let hi = lines.length;
	while (lo < hi) {
		const mid = Math.floor((lo + hi + 1) / 2);
		if (Buffer.byteLength(lines.slice(0, mid).join("\n"), "utf-8") <= MAX_BYTES) lo = mid;
		else hi = mid - 1;
	}

	return {
		output: lines.slice(0, lo).join("\n"),
		shownLineCount: lo,
		truncated: lo < lines.length,
		firstLineExceedsLimit: lo === 0 && lines.length > 0,
	};
}

export function registerReadTool(pi: ExtensionAPI, snapshots: InMemorySnapshotStore) {
	pi.registerTool({
		name: "read",
		label: "Read",
		description:
			"Read a file with hashline anchors. Returns [PATH#TAG] header followed by LINE:TEXT lines. " +
			"Copy the #TAG into your edit calls to anchor edits to this exact file version.",
		parameters: Type.Object({
			path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
			offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
			limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const offsetError = validatePositiveInteger("Offset", params.offset);
				if (offsetError) {
					return { content: [{ type: "text", text: offsetError }], details: { error: offsetError } };
				}
				const limitError = validatePositiveInteger("Limit", params.limit);
				if (limitError) {
					return { content: [{ type: "text", text: limitError }], details: { error: limitError } };
				}

				const absolutePath = canonicalPath(ctx.cwd, params.path);

				try {
					await access(absolutePath, constants.R_OK);
				} catch (e) {
					console.error(`pi-hashline-omp: read access failed for ${absolutePath}:`, e);
					return {
						content: [{ type: "text", text: `File not found: ${params.path}` }],
						details: { error: `File not found: ${params.path}` },
					};
				}

				// Image handling: return as proper image attachment
				const mimeType = detectImageMimeType(absolutePath);
				if (mimeType) {
					let buffer: Buffer;
					try {
						buffer = await readFile(absolutePath);
					} catch (e: any) {
						const message = e.message ?? String(e);
						console.error(`pi-hashline-omp: image read failed for ${absolutePath}:`, e);
						return {
							content: [{ type: "text", text: `Read failed: ${message}` }],
							details: { error: message },
						};
					}
					return {
						content: [
							{ type: "text", text: `Read image file [${mimeType}]` },
						{ type: "image" as any, data: buffer.toString("base64"), mimeType },
					],
					details: {},
					};
				}

				let buffer: Buffer;
				try {
					buffer = await readFile(absolutePath);
				} catch (e: any) {
					const message = e.message ?? String(e);
					console.error(`pi-hashline-omp: text read failed for ${absolutePath}:`, e);
					return {
						content: [{ type: "text", text: `Read failed: ${message}` }],
						details: { error: message },
					};
				}

				// Binary detection
				let isBinary = false;
			const max = Math.min(buffer.length, 512);
			for (let i = 0; i < max; i++) {
				if (buffer[i] === 0) { isBinary = true; break; }
			}
				if (isBinary) {
					return {
						content: [{ type: "text", text: `Binary file: ${params.path} (use bash tools to inspect)` }],
					details: {},
					};
				}

				const content = buffer.toString("utf-8");
				const allLines = splitFileLines(content);

				// Empty file
				if (allLines.length === 0) {
					const fileHash = snapshots.record(absolutePath, content, new Set());
					const header = formatHashlineHeader(params.path, fileHash);
					return {
						content: [{ type: "text", text: `${header}\nFile is empty. Use edit with INS.HEAD or INS.TAIL to add content.` }],
						details: { path: params.path, fileHash, lines: 0, shown: 0, truncated: false },
					};
				}

				// Apply offset/limit — error on bad offset, don't clamp
				const startLine = params.offset ?? 1;
				if (startLine > allLines.length) {
				return {
					content: [{ type: "text", text: `Offset ${startLine} is beyond end of file (${allLines.length} lines)` }],
					details: {},
				};
			}
			if (startLine < 1) {
				return {
					content: [{ type: "text", text: `Offset ${startLine} is invalid (must be >= 1)` }],
					details: {},
					};
				}
				const requestedEnd = params.limit === undefined ? allLines.length : startLine + params.limit - 1;
				const maxEnd = Math.min(allLines.length, startLine + MAX_LINES - 1);
				const endLine = Math.min(requestedEnd, maxEnd);

				const sliced = allLines.slice(startLine - 1, endLine);
				const truncation = truncateWholeLines(sliced);
				const { output, shownLineCount, truncated, firstLineExceedsLimit } = truncation;

				// Record snapshot with seenLines for protection
				const seenLines = new Set<number>();
				for (let i = startLine; i < startLine + shownLineCount; i++) seenLines.add(i);
				const fileHash = snapshots.record(absolutePath, content, seenLines);

				// Build output
				const header = formatHashlineHeader(params.path, fileHash);
				const body = shownLineCount > 0 ? formatNumberedLines(output, startLine) : "";

				let prefix = "";
				let suffix = "";
				if (startLine > 1) prefix = `... (lines 1-${startLine - 1} elided)\n`;
				const lastShown = startLine + shownLineCount - 1;
				if (lastShown < allLines.length) suffix = `\n... (lines ${lastShown + 1}-${allLines.length} elided)`;
				if (truncated) suffix += `\n[Truncated to ${MAX_BYTES / 1024}KB — use offset/limit for remainder]`;
				if (firstLineExceedsLimit) suffix += `\n[First requested line exceeds ${MAX_BYTES / 1024}KB and was not shown as an editable anchor]`;

				return {
					content: [{ type: "text", text: `${prefix}${header}${body ? "\n" + body : ""}${suffix}` }],
					details: { path: params.path, fileHash, lines: allLines.length, shown: shownLineCount, truncated, firstLineExceedsLimit },
				};
			},
		});
}
