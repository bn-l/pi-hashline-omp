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

interface StripState {
	blockComment: boolean;
	template: boolean;
}

function canStartRegexLiteral(output: string): boolean {
	const trimmed = output.trimEnd();
	if (trimmed === "") return true;
	if (/\b(?:return|throw|case|delete|void|typeof|yield|await)$/.test(trimmed)) return true;
	const last = trimmed[trimmed.length - 1]!;
	return "([{=,:;!&|?+-*%^~<>".includes(last);
}

function skipRegexLiteral(line: string, start: number): number {
	let i = start + 1;
	let inClass = false;
	while (i < line.length) {
		if (line[i] === "\\") {
			i += 2;
			continue;
		}
		if (line[i] === "[" && !inClass) {
			inClass = true;
			i++;
			continue;
		}
		if (line[i] === "]" && inClass) {
			inClass = false;
			i++;
			continue;
		}
		if (line[i] === "/" && !inClass) {
			i++;
			while (/[A-Za-z]/.test(line[i] ?? "")) i++;
			return i;
		}
		i++;
	}
	return i;
}

/** Strip string literals and comments from a line before brace counting. */
function stripStringsAndComments(line: string, state: StripState): string {
	let result = "";
	let i = 0;
	while (i < line.length) {
		if (state.blockComment) {
			const end = line.indexOf("*/", i);
			if (end === -1) return result;
			state.blockComment = false;
			i = end + 2;
			continue;
		}
		if (state.template) {
			if (line[i] === "\\") { i += 2; continue; }
			if (line[i] === "`") {
				state.template = false;
				i++;
				continue;
			}
			i++;
			continue;
		}
		// Single-line comment
		if (line[i] === '/' && line[i + 1] === '/') break;
		// Block comment start
		if (line[i] === '/' && line[i + 1] === '*') {
			state.blockComment = true;
			i += 2;
			continue;
		}
		// Regex literals
		if (line[i] === "/" && canStartRegexLiteral(result)) {
			i = skipRegexLiteral(line, i);
			continue;
		}
		// Template literals
		if (line[i] === "`") {
			state.template = true;
			i++;
			continue;
		}
		// String literals
		if (line[i] === '"' || line[i] === "'") {
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
	const state: StripState = { blockComment: false, template: false };
	for (let i = idx; i < lines.length; i++) {
		const cleaned = stripStringsAndComments(lines[i]!, state);
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

	const headerLine = lines[idx]!;
	if (headerLine.trim() === "") return null;

	// Only resolve if the line ends with ':' (def, class, if, for, while, etc.)
	// or starts with a decorator (@)
	const isColonHeader = headerLine.trimEnd().endsWith(":");
	const isDecorator = headerLine.trimStart().startsWith("@");
	if (!isColonHeader && !isDecorator) return null;
	if (isDecorator) {
		let decoratedIdx = idx + 1;
		while (decoratedIdx < lines.length && (lines[decoratedIdx]!.trim() === "" || lines[decoratedIdx]!.trimStart().startsWith("@") || lines[decoratedIdx]!.trimStart().startsWith("#"))) {
			decoratedIdx++;
		}
		if (decoratedIdx >= lines.length || !lines[decoratedIdx]!.trimEnd().endsWith(":")) return null;
		const decorated = resolvePythonBlock(text, decoratedIdx + 1);
		return decorated ? { start: line, end: decorated.end } : null;
	}

	// Determine the indentation level of the first body line
	const headerIndent = headerLine.length - headerLine.trimStart().length;
	// Find the first non-blank, non-comment line after the header
	let bodyIdx = idx + 1;
	while (bodyIdx < lines.length && (lines[bodyIdx]!.trim() === "" || lines[bodyIdx]!.trimStart().startsWith("#"))) {
		bodyIdx++;
	}
	if (bodyIdx >= lines.length) {
		return { start: line, end: line };
	}

	const bodyLine = lines[bodyIdx]!;
	const bodyIndent = bodyLine.length - bodyLine.trimStart().length;

	if (bodyIndent <= headerIndent) return null;

	let endIdx = bodyIdx;
	for (let i = bodyIdx + 1; i < lines.length; i++) {
		const trimmed = lines[i]!.trim();
		if (trimmed === "" || trimmed.startsWith("#")) {
			endIdx = i;
			continue;
		}
		const lineIndent = lines[i]!.length - lines[i]!.trimStart().length;
		if (lineIndent >= bodyIndent) {
			endIdx = i;
		} else {
			break;
		}
	}

	while (endIdx > bodyIdx && lines[endIdx]!.trim() === "") {
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
	const trimmed = lines[idx]!.trimStart();
	const keyword = (trimmed.split(/\s/)[0]!) as string;

	if (!openers[keyword] && !trimmed.startsWith("{")) return null;

	if (trimmed.startsWith("{")) {
		return resolveBraceBlock(text, line);
	}

	const closer = openers[keyword]!;
	if (!closer) return null;

	// Simple keyword counting (handles nested structures)
	let depth = 1;
	for (let i = idx + 1; i < lines.length; i++) {
		const firstWord = lines[i]!.trimStart().split(/\s/)[0]!;
		if (openers[firstWord] === closer) {
			depth++;
			continue;
		}
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

	const headerMatch = lines[idx]!.match(/^(#{1,6})\s/);
	if (!headerMatch) return null;

	const headerLevel = headerMatch[1]!.length;
	for (let i = idx + 1; i < lines.length; i++) {
		const match = lines[i]!.match(/^(#{1,6})\s/);
		if (match && match[1]!.length <= headerLevel) {
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
