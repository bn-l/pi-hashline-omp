/**
 * Hashline grep tool — overrides pi's built-in grep/ripgrep.
 *
 * Searches files and returns results with hashline anchors so the
 * model can feed search results directly into edit calls.
 *
 * Output format:
 *   [path#TAG]
 *   42:matching line content
 *   57:another match
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import {
	computeFileHash,
	formatHashlineHeader,
	formatNumberedLines,
	type InMemorySnapshotStore,
} from "@oh-my-pi/hashline";

export function registerGrepTool(pi: ExtensionAPI, snapshots: InMemorySnapshotStore) {
	pi.registerTool({
		name: "grep",
		label: "Grep",
		description:
			"Search file contents using ripgrep. Returns results with hashline anchors " +
			"([PATH#TAG] + LINE:TEXT) so matches feed directly into edit calls. " +
			"Patterns use ripgrep regex syntax. Use -i flag for case-insensitive search.",
		parameters: Type.Object({
			pattern: Type.String({ description: "Ripgrep regex pattern to search for" }),
			path: Type.Optional(Type.String({ description: "File or directory to search (default: current directory)" })),
			glob: Type.Optional(Type.String({ description: "Glob pattern to filter files (e.g., '*.ts')" })),
			maxResults: Type.Optional(Type.Number({ description: "Maximum results to return (default: 50)" })),
			caseSensitive: Type.Optional(Type.Boolean({ description: "Case-sensitive search (default: smart-case)" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const searchPath = params.path ? resolve(ctx.cwd, params.path) : ctx.cwd;
			const maxResults = params.maxResults ?? 50;

			// Build ripgrep args
			const args: string[] = ["--line-number", "--no-heading", "--color=never"];
			if (params.glob) args.push("--glob", params.glob);
			if (params.caseSensitive === true) args.push("--case-sensitive");
			else if (params.caseSensitive === false) args.push("--ignore-case");
			args.push("--max-count", String(Math.min(maxResults, 200)));
			// Escape single quotes in pattern for shell
			const safePattern = params.pattern.replace(/'/g, "'\\''");
			args.push(safePattern);
			args.push(searchPath);

			let output: string;
			try {
				const result = spawnSync('rg', args, { timeout: 30000, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
				if (result.status !== 0 && result.status !== 1) {
					if (result.status === 2) throw new Error(result.stderr || 'ripgrep error');
				}
				output = result.stdout || '';
			} catch {
				return {
					content: [{ type: "text", text: `No matches found for: ${params.pattern}` }],
					details: { matches: 0 },
				};
			}

			if (!output.trim()) {
				return {
					content: [{ type: "text", text: `No matches found for: ${params.pattern}` }],
					details: { matches: 0 },
				};
			}

			// Parse ripgrep output: "path:line:text"
			const lines = output.trim().split("\n").slice(0, maxResults);
			const fileMatches = new Map<string, number[]>(); // path → [lineNumbers]

			for (const line of lines) {
				const colonIdx = line.indexOf(":");
				if (colonIdx < 0) continue;
				const secondColonIdx = line.indexOf(":", colonIdx + 1);
				if (secondColonIdx < 0) continue;

				const filePath = line.substring(0, colonIdx);
				const lineNum = parseInt(line.substring(colonIdx + 1, secondColonIdx), 10);
				if (isNaN(lineNum)) continue;

				if (!fileMatches.has(filePath)) fileMatches.set(filePath, []);
				fileMatches.get(filePath)!.push(lineNum);
			}

			// Build hashline output per file
			const parts: string[] = [];
			for (const [filePath, matchLines] of fileMatches) {
				let content: string;
				try {
					content = await readFile(resolve(ctx.cwd, filePath), "utf-8");
				} catch {
					continue;
				}

				const fileHash = snapshots.record(filePath, content);
				const allLines = content.split("\n");

				// Collect matching lines with context
				const shown = new Set<number>();
				for (const ml of matchLines) {
					// Show the matching line ±1 context
					for (let i = Math.max(1, ml - 1); i <= Math.min(allLines.length, ml + 1); i++) {
						shown.add(i);
					}
				}

				const sortedShown = [...shown].sort((a, b) => a - b);

				// Build output with elision markers
				const header = formatHashlineHeader(filePath, fileHash);
				let body = "";
				let prevLine = 0;
				for (const lineNum of sortedShown) {
					if (prevLine > 0 && lineNum > prevLine + 1) {
						body += `... (lines ${prevLine + 1}-${lineNum - 1} elided)\n`;
					}
					body += `${lineNum}:${allLines[lineNum - 1]}\n`;
					prevLine = lineNum;
				}

				parts.push(`${header}\n${body.trimEnd()}`);
			}

			if (parts.length === 0) {
				return {
					content: [{ type: "text", text: `No matches found for: ${params.pattern}` }],
					details: { matches: 0 },
				};
			}

			return {
				content: [{ type: "text", text: parts.join("\n\n") }],
				details: { matches: lines.length, files: fileMatches.size },
			};
		},
	});
}
