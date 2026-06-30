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
import { resolve } from "node:path";
import {
	computeFileHash,
	formatHashlineHeader,
	formatNumberedLines,
	type InMemorySnapshotStore,
} from "@oh-my-pi/hashline";

// Image extensions that should fall through to pi's built-in image handling
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".svg"]);

// Binary signatures to detect before reading full file
function isImagePath(p: string): boolean {
	const ext = p.split(".").pop()?.toLowerCase();
	if (!ext) return false;
	return IMAGE_EXTENSIONS.has(`.${ext}`);
}

function detectBinary(buffer: Buffer): boolean {
	// Check first 512 bytes for null bytes (common heuristic)
	const max = Math.min(buffer.length, 512);
	for (let i = 0; i < max; i++) {
		if (buffer[i] === 0) return true;
	}
	return false;
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
			const absolutePath = resolve(ctx.cwd, params.path);

			// Images: fall through to pi's built-in read for attachment handling
			if (isImagePath(absolutePath)) {
				return { content: [{ type: "text", text: `[image detected — use pi's built-in read]` }], details: {} };
			}

			try {
				await access(absolutePath, constants.R_OK);
			} catch {
				return {
					content: [{ type: "text", text: `File not found: ${params.path}` }],
					details: {},
				};
			}

			const buffer = await readFile(absolutePath);

			// Binary detection
			if (detectBinary(buffer)) {
				return {
					content: [{ type: "text", text: `Binary file: ${params.path} (use bash tools to inspect)` }],
					details: {},
				};
			}

			let content = buffer.toString("utf-8");
			const allLines = content.split("\n");

			// Empty file
			if (allLines.length === 1 && allLines[0] === "") {
				return {
					content: [{ type: "text", text: `[${params.path}#----]\nFile is empty. Use write tool to create content.` }],
					details: {},
				};
			}

			// Strip trailing empty line from split (files usually end with \n)
			if (allLines.length > 0 && allLines[allLines.length - 1] === "") {
				allLines.pop();
			}

			// Apply offset/limit
			const startLine = params.offset ?? 1;
			const endLine = params.limit ? startLine + params.limit - 1 : allLines.length;
			const clampedStart = Math.max(1, Math.min(startLine, allLines.length));
			const clampedEnd = Math.max(clampedStart, Math.min(endLine, allLines.length));

			if (clampedStart > allLines.length) {
				return {
					content: [{ type: "text", text: `Offset ${startLine} is beyond end of file (${allLines.length} lines)` }],
					details: {},
				};
			}

			const sliced = allLines.slice(clampedStart - 1, clampedEnd);

			// Record snapshot for the full file (not just the slice)
			const fileHash = snapshots.record(absolutePath, content);

			// Build output
			const header = formatHashlineHeader(params.path, fileHash);
			const body = formatNumberedLines(sliced.join("\n"), clampedStart);

			// Add elision markers if partial read
			let prefix = "";
			let suffix = "";
			if (clampedStart > 1) prefix = `... (lines 1-${clampedStart - 1} elided)\n`;
			if (clampedEnd < allLines.length) suffix = `\n... (lines ${clampedEnd + 1}-${allLines.length} elided)`;

			return {
				content: [{ type: "text", text: `${prefix}${header}\n${body}${suffix}` }],
				details: { path: params.path, fileHash, lines: allLines.length, shown: sliced.length },
			};
		},
	});
}
