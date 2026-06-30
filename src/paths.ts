import { isAbsolute, relative, resolve } from "node:path";

export function canonicalPath(cwd: string, path: string): string {
	return resolve(cwd, path);
}

export function isPathInside(parent: string, child: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function workspaceRoot(cwd: string): string {
	return canonicalPath(cwd, ".");
}
