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
	formatHashlineHeader,
	formatNumberedLines,
	type InMemorySnapshotStore,
} from "@oh-my-pi/hashline";

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

			try {
				await access(absolutePath, constants.R_OK);
			} catch {
				return {
					content: [{ type: "text", text: `File not found: ${params.path}` }],
					details: {},
				};
			}

			// Image handling: return as proper image attachment
			const mimeType = detectImageMimeType(absolutePath);
			if (mimeType) {
				const buffer = await readFile(absolutePath);
				return {
					content: [
						{ type: "text", text: `Read image file [${mimeType}]` },
						{ type: "image" as any, data: buffer.toString("base64"), mimeType },
					],
					details: {},
				};
			}

			const buffer = await readFile(absolutePath);

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
			const maxEnd = Math.min(allLines.length, startLine + MAX_LINES - 1);
			const endLine = params.limit ? Math.min(startLine + params.limit - 1, maxEnd) : maxEnd;

			const sliced = allLines.slice(startLine - 1, endLine);
			let output = sliced.join("\n");

			// Byte truncation
			let truncated = false;
			if (Buffer.byteLength(output, "utf-8") > MAX_BYTES) {
				let lo = 0, hi = sliced.length;
				while (lo < hi) {
					const mid = Math.floor((lo + hi) / 2);
					if (Buffer.byteLength(sliced.slice(0, mid).join("\n"), "utf-8") <= MAX_BYTES) lo = mid + 1;
					else hi = mid;
				}
				const keep = Math.max(1, lo - 1);
				output = sliced.slice(0, keep).join("\n");
				truncated = keep < sliced.length;
			}

			// Record snapshot with seenLines for protection
			const seenLines = new Set<number>();
			for (let i = startLine; i < startLine + output.split("\n").length; i++) seenLines.add(i);
			const fileHash = snapshots.record(absolutePath, content, seenLines);

			// Build output
			const header = formatHashlineHeader(params.path, fileHash);
			const body = formatNumberedLines(output, startLine);

			let prefix = "";
			let suffix = "";
			if (startLine > 1) prefix = `... (lines 1-${startLine - 1} elided)\n`;
			const lastShown = startLine + output.split("\n").length - 1;
			if (lastShown < allLines.length) suffix = `\n... (lines ${lastShown + 1}-${allLines.length} elided)`;
			if (truncated) suffix += `\n[Truncated to ${MAX_BYTES / 1024}KB — use offset/limit for remainder]`;

			return {
				content: [{ type: "text", text: `${prefix}${header}\n${body}${suffix}` }],
				details: { path: params.path, fileHash, lines: allLines.length, shown: Math.min(output.split("\n").length, endLine - startLine + 1), truncated },
			};
		},
	});
}
