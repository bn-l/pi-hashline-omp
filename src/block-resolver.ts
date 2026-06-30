/**
 * Bracket/indentation-based block resolver for oh-my-pi hashline BLK ops.
 *
 * Resolves `SWAP.BLK N` / `DEL.BLK N` / `INS.BLK.POST N` anchors to
 * concrete line spans without needing tree-sitter or WASM.
 *
 * Strategy per language family:
 *   - Brace languages (TS, JS, Rust, Go, C, C++, Java, etc.): count `{` and `}`
 *     from the anchor line to find the matching closing brace.
 *   - Python: count indentation levels from the anchor line.
 *   - JSON: brace-counting.
 *   - Shell: keyword-pair matching (if/fi, case/esac, do/done).
 *   - Markdown: heading-level based section detection.
 *
 * Returns { start, end } line span (1-indexed, inclusive) or null when the
 * language is unsupported or no block can be resolved.
 */
import type { BlockResolver, BlockSpan } from "@oh-my-pi/hashline";

/** File extension → language family. */
function classify(path: string): string | null {
	const ext = path.split(".").pop()?.toLowerCase();
	if (!ext) return null;
	const braceExts = new Set([
		"ts", "tsx", "js", "jsx", "mjs", "cjs",
		"rs", "go", "c", "cpp", "cc", "cxx", "h", "hpp",
		"java", "kt", "kts", "swift", "scala",
		"cs", "fs", "fsx",
		"json", "jsonc",
	]);
	if (braceExts.has(ext)) return "brace";
	if (ext === "py" || ext === "pyi") return "python";
	if (ext === "sh" || ext === "bash" || ext === "zsh") return "shell";
	if (ext === "md" || ext === "mdx") return "markdown";
	// Extensionless shell rc files
	const basename = path.split("/").pop() ?? "";
	if (basename === "zshrc" || basename === "bashrc" || basename.startsWith(".") && /rc$|profile$/.test(basename)) {
		return "shell";
	}
	return null;
}

/** Strip string literals and comments from a line before brace counting. */
function stripStringsAndComments(line: string): string {
	let result = "";
	let i = 0;
	while (i < line.length) {
		// Single-line comment
		if (line[i] === '/' && line[i + 1] === '/') break;
		// Block comment start
		if (line[i] === '/' && line[i + 1] === '*') {
			i += 2;
			while (i < line.length - 1 && !(line[i] === '*' && line[i + 1] === '/')) i++;
			i += 2;
			continue;
		}
		// String literals (single, double, template)
		if (line[i] === '"' || line[i] === "'" || line[i] === '`') {
			const quote = line[i];
			i++;
			while (i < line.length) {
				if (line[i] === '\\') { i += 2; continue; }
				if (line[i] === quote) { i++; break; }
				i++;
			}
			continue;
		}
		result += line[i];
		i++;
	}
	return result;
}

/** Find the matching closing brace line for brace-languages. */
function resolveBraceBlock(text: string, line: number): BlockSpan | null {
	const lines = text.split("\n");
	const idx = line - 1;
	if (idx < 0 || idx >= lines.length) return null;

	// Find the opening brace on or after the anchor line.
	let depth = 0;
	let foundOpen = false;
	let start = idx;
	for (let i = idx; i < lines.length; i++) {
		const cleaned = stripStringsAndComments(lines[i]);
		for (const ch of cleaned) {
			if (ch === "{") {
				if (!foundOpen) {
					foundOpen = true;
					start = i;
				}
				depth++;
			} else if (ch === "}") {
				if (!foundOpen) {
					return null;
				}
				depth--;
				if (depth === 0) {
					return { start: start + 1, end: i + 1 };
				}
			}
		}
	}
	return null;
}

/** Find the matching indentation block for Python. */
function resolvePythonBlock(text: string, line: number): BlockSpan | null {
	const lines = text.split("\n");
	const idx = line - 1;
	if (idx < 0 || idx >= lines.length) return null;

	const headerLine = lines[idx];
	if (headerLine.trim() === "") return null; // Blank line

	// Only resolve if the line ends with ':' (def, class, if, for, while, etc.)
	// or starts with a decorator (@)
	const isColonHeader = headerLine.trimEnd().endsWith(":");
	const isDecorator = headerLine.trimStart().startsWith("@");
	if (!isColonHeader && !isDecorator) return null;

	// Determine the indentation level of the first body line
	const headerIndent = headerLine.length - headerLine.trimStart().length;
	// Find the first non-blank, non-comment line after the header
	let bodyIdx = idx + 1;
	while (bodyIdx < lines.length && (lines[bodyIdx].trim() === "" || lines[bodyIdx].trimStart().startsWith("#"))) {
		bodyIdx++;
	}
	if (bodyIdx >= lines.length) {
		// Empty body — single-line block
		return { start: line, end: line };
	}

	const bodyLine = lines[bodyIdx];
	const bodyIndent = bodyLine.length - bodyLine.trimStart().length;

	// If body isn't indented more than header, it's not a block
	if (bodyIndent <= headerIndent) return null;

	// Find the last line at >= bodyIndent (exclude trailing blank-only lines)
	let endIdx = bodyIdx;
	for (let i = bodyIdx + 1; i < lines.length; i++) {
		const trimmed = lines[i].trim();
		if (trimmed === "" || trimmed.startsWith("#")) {
			// Blank/comment lines don't end the block, but only if there's
			// subsequent indented content — otherwise don't extend past last real content
			endIdx = i;
			continue;
		}
		const lineIndent = lines[i].length - lines[i].trimStart().length;
		if (lineIndent >= bodyIndent) {
			endIdx = i;
		} else {
			break;
		}
	}

	// Don't extend past the last non-empty line (trailing blank lines from
	// trailing newline aren't part of the block)
	while (endIdx > bodyIdx && lines[endIdx].trim() === "") {
		endIdx--;
	}

	return { start: line, end: endIdx + 1 };
}

/** Resolve if/fi, case/esac, do/done, for/done blocks in shell. */
function resolveShellBlock(text: string, line: number): BlockSpan | null {
	const lines = text.split("\n");
	const idx = line - 1;
	if (idx < 0 || idx >= lines.length) return null;

	const openers: Record<string, string> = {
		"if": "fi",
		"case": "esac",
		"for": "done",
		"while": "done",
		"until": "done",
		"{": "}",
		"((": "))",
	};
	const trimmed = lines[idx].trimStart();
	const keyword = trimmed.split(/\s/)[0];

	if (!openers[keyword] && !trimmed.startsWith("{")) return null;

	if (trimmed.startsWith("{")) {
		// Fall back to brace counting
		return resolveBraceBlock(text, line);
	}

	const closer = openers[keyword];
	if (!closer) return null;

	// Simple keyword counting (handles nested structures)
	let depth = 1;
	for (let i = idx + 1; i < lines.length; i++) {
		const firstWord = lines[i].trimStart().split(/\s/)[0];
		if (firstWord === keyword) depth++;
		if (firstWord === closer) {
			depth--;
			if (depth === 0) return { start: line, end: i + 1 };
		}
	}
	return null;
}

/** Resolve markdown heading sections. */
function resolveMarkdownBlock(text: string, line: number): BlockSpan | null {
	const lines = text.split("\n");
	const idx = line - 1;
	if (idx < 0 || idx >= lines.length) return null;

	const headerMatch = lines[idx].match(/^(#{1,6})\s/);
	if (!headerMatch) return null;

	const headerLevel = headerMatch[1].length;
	// Find the next heading at same or higher level
	for (let i = idx + 1; i < lines.length; i++) {
		const match = lines[i].match(/^(#{1,6})\s/);
		if (match && match[1].length <= headerLevel) {
			return { start: line, end: i }; // End just before next heading
		}
	}
	return { start: line, end: lines.length };
}

export function createBlockResolver(): BlockResolver {
	return (request): BlockSpan | null => {
		const lang = classify(request.path);
		if (!lang) return null;

		switch (lang) {
			case "brace":
				return resolveBraceBlock(request.text, request.line);
			case "python":
				return resolvePythonBlock(request.text, request.line);
			case "shell":
				return resolveShellBlock(request.text, request.line);
			case "markdown":
				return resolveMarkdownBlock(request.text, request.line);
			default:
				return null;
		}
	};
}
