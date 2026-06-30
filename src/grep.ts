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
import { execFile } from "node:child_process";
import {
	formatHashlineHeader,
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
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const searchPath = params.path ? resolve(ctx.cwd, params.path) : ctx.cwd;
			const maxResults = params.maxResults ?? 50;

			// Build ripgrep args — use --json for robust parsing
			const args: string[] = ["--json", "--no-heading", "--with-filename", "--color=never"];
			if (params.glob) args.push("--glob", params.glob);
			if (params.caseSensitive === true) args.push("--case-sensitive");
			else if (params.caseSensitive === false) args.push("--ignore-case");
			args.push("--max-count", String(Math.min(maxResults, 200)));
			// Use -e for pattern to protect dash-prefixed patterns
			args.push("-e", params.pattern);
			// -- separates options from paths
			args.push("--", searchPath);

			let rawOutput: string;
			try {
				rawOutput = await new Promise<string>((resolve, reject) => {
					const child = execFile('rg', args, { timeout: 30000, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
						if (err) {
							if (err.killed) { resolve(stdout || ''); return; }
							// rg exits 1 = no matches, 2 = error
							if ((err as any).code === 1) { resolve(stdout || ''); return; }
							reject(new Error(stderr || err.message));
							return;
						}
						resolve(stdout);
					});
					if (signal) {
						signal.addEventListener('abort', () => child.kill(), { once: true });
					}
				});
			} catch (e: any) {
				return {
					content: [{ type: "text", text: `rg failed: ${e.message}` }],
					details: { error: e.message },
				};
			}

			if (!rawOutput.trim()) {
				return {
					content: [{ type: "text", text: `No matches found for: ${params.pattern}` }],
					details: { matches: 0 },
				};
			}

			// Parse rg --json output: one JSON object per line
			const jsonLines = rawOutput.trim().split("\n");
			const fileMatches = new Map<string, number[]>(); // path → [lineNumbers]
			let matchCount = 0;

			for (const line of jsonLines) {
				if (matchCount >= maxResults) break;
				try {
					const obj = JSON.parse(line);
					if (obj.type !== "match") continue;
					const d = obj.data;
					const filePath = d.path?.text;
					const lineNum = d.line_number;
					if (!filePath || typeof lineNum !== "number") continue;
					if (!fileMatches.has(filePath)) fileMatches.set(filePath, []);
					fileMatches.get(filePath)!.push(lineNum);
					matchCount++;
				} catch (e) { console.error("pi-hashline-omp: grep JSON parse error:", e); continue; }
			}

			// Build hashline output per file
			const parts: string[] = [];
			for (const [filePath, matchLines] of fileMatches) {
				let content: string;
				try {
					content = await readFile(resolve(ctx.cwd, filePath), "utf-8");
				} catch (e) {
					console.error("pi-hashline-omp: grep read error:", e);
					continue;
				}

				const allLines = content.split("\n");

				// Collect matching lines with context
				const shown = new Set<number>();
				for (const ml of matchLines) {
					for (let i = Math.max(1, ml - 1); i <= Math.min(allLines.length, ml + 1); i++) {
						shown.add(i);
					}
				}

				// Record snapshot with seenLines for edit protection
				const fileHash = snapshots.record(filePath, content, shown);

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
				details: { matches: matchCount, files: fileMatches.size },
			};
		},
	});
}
