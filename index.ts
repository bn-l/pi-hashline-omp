/**
 * pi-hashline-omp
 *
 * A pi coding-agent extension that replaces the built-in read, edit, and grep
 * tools with oh-my-pi's hashline editing system.
 *
 * Powered by @oh-my-pi/hashline (the standalone hashline engine extracted from
 * oh-my-pi) and a bracket/indentation-based block resolver for syntactic block
 * operations (SWAP.BLK, DEL.BLK, INS.BLK.POST).
 */

// Install Bun.hash.xxHash32 before importing @oh-my-pi/hashline dependents.
import "./src/hash-polyfill";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerReadTool } from "./src/read";
import { registerEditTool } from "./src/edit";
import { registerGrepTool } from "./src/grep";
import { createBlockResolver } from "./src/block-resolver";
import { createSnapshotStore } from "./src/snapshot-store";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Load the hashline patch language prompt (bundled with the extension)
const __dirname = dirname(fileURLToPath(import.meta.url));
const hashlinePrompt = readFileSync(join(__dirname, "prompts", "hashline-edit.md"), "utf-8");

export default function (pi: ExtensionAPI) {
	const snapshots = createSnapshotStore();
	const blockResolver = createBlockResolver();

	try {
		registerReadTool(pi, snapshots);
		registerEditTool(pi, snapshots, blockResolver);
		registerGrepTool(pi, snapshots);
	} catch (e) {
		console.error("pi-hashline-omp: registration failed:", e);
		throw e;
	}

	// Inject the hashline patch language instructions into the system prompt
	pi.on("before_agent_start", async (event, _ctx) => {
		return {
			systemPrompt: (event.systemPrompt ?? "") + "\n\n" + hashlinePrompt,
		};
	});

	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.notify("pi-hashline-omp: hashline read/edit/grep active", "info");
	});
}
