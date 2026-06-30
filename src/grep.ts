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
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import {
	formatHashlineHeader,
	type InMemorySnapshotStore,
} from "@oh-my-pi/hashline";
import { canonicalPath, workspaceRoot } from "./paths";

function validatePositiveInteger(name: string, value: number | undefined): string | undefined {
	if (value === undefined) return undefined;
	if (!Number.isInteger(value) || value < 1) return `${name} ${value} is invalid (must be a positive integer)`;
	return undefined;
}

function decodeJsonText(value: unknown): string | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as { text?: unknown; bytes?: unknown };
	if (typeof record.text === "string") return record.text;
	if (typeof record.bytes === "string") return Buffer.from(record.bytes, "base64").toString("utf-8");
	return undefined;
}

function hasBytesPayload(value: unknown): boolean {
	return !!value && typeof value === "object" && typeof (value as { bytes?: unknown }).bytes === "string";
}

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
				const maxResultsError = validatePositiveInteger("maxResults", params.maxResults);
				if (maxResultsError) {
					return { content: [{ type: "text", text: maxResultsError }], details: { error: maxResultsError } };
				}
				const searchPath = params.path ? canonicalPath(ctx.cwd, params.path) : workspaceRoot(ctx.cwd);
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
						const child = execFile("rg", args, { timeout: 30000, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
							if (err) {
								if (err.killed) { resolve(stdout || ""); return; }
								// rg exits 1 = no matches, 2 = error
								if ((err as any).code === 1) { resolve(stdout || ""); return; }
								reject(new Error(stderr || err.message));
								return;
							}
						resolve(stdout);
						});
						if (signal) {
							signal.addEventListener("abort", () => child.kill(), { once: true });
						}
					});
				} catch (e: any) {
					console.error("pi-hashline-omp: rg failed:", e);
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
				const binaryPaths = new Set<string>();
				const nonUtf8Paths = new Set<string>();
				let matchCount = 0;

				for (const line of jsonLines) {
					try {
						const obj = JSON.parse(line);
						const data = obj.data;
						const filePath = decodeJsonText(data?.path);
						if (filePath && hasBytesPayload(data?.path)) nonUtf8Paths.add(filePath);
						switch (obj.type) {
							case "match": {
								if (matchCount >= maxResults) break;
								const lineNum = data?.line_number;
								if (!filePath || typeof lineNum !== "number") continue;
								if (hasBytesPayload(data?.lines)) nonUtf8Paths.add(filePath);
								if (!fileMatches.has(filePath)) fileMatches.set(filePath, []);
								fileMatches.get(filePath)!.push(lineNum);
								matchCount++;
								break;
							}
							case "end":
								if (filePath && typeof data?.binary_offset === "number") binaryPaths.add(filePath);
								break;
							case "begin":
							case "context":
							case "summary":
								break;
							default:
								console.error("pi-hashline-omp: unknown rg JSON event type:", obj.type);
								break;
						}
					} catch (e) { console.error("pi-hashline-omp: grep JSON parse error:", e); continue; }
				}

				// Build hashline output per file
				const parts: string[] = [];
				const warnings: string[] = [];
				for (const filePath of binaryPaths) {
					fileMatches.delete(filePath);
					warnings.push(`Skipped binary match in ${filePath}`);
				}
				for (const filePath of nonUtf8Paths) {
					fileMatches.delete(filePath);
					warnings.push(`Skipped non-UTF8 match in ${filePath}`);
				}
				for (const [filePath, matchLines] of fileMatches) {
					let content: string;
					try {
						content = await readFile(canonicalPath(ctx.cwd, filePath), "utf-8");
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
					const warningText = warnings.length > 0 ? `\n${warnings.join("\n")}` : "";
					return {
						content: [{ type: "text", text: `No text matches found for: ${params.pattern}${warningText}` }],
						details: { matches: 0, warnings },
					};
				}

				const warningText = warnings.length > 0 ? `\n\nWarnings:\n${warnings.join("\n")}` : "";
				return {
					content: [{ type: "text", text: `${parts.join("\n\n")}${warningText}` }],
					details: { matches: matchCount, files: fileMatches.size, warnings },
				};
			},
		});
}
