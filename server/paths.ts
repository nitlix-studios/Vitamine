import { homedir } from "node:os";
import { join } from "node:path";

// Everything Vitamine keeps on disk lives in ~/.vitamine so an npm upgrade never touches it.
export const HOME = process.env.VITAMINE_HOME ?? join(homedir(), ".vitamine");
export const LOG_FILE = join(HOME, "server.log");
export const PID_FILE = join(HOME, "server.pid");
export const SCRIPTS_DIR = process.env.VITAMINE_SCRIPTS_DIR ?? join(HOME, "scripts");

export const PORT = Number(process.env.VITAMINE_PORT ?? 9333);
export const BASE = `http://127.0.0.1:${PORT}`;

// Extension IDs the server accepts. The dev ID is pinned by the `key` in extension/manifest.json;
// add the Chrome Web Store ID here once the listing exists.
export const EXTENSION_IDS = process.env.VITAMINE_EXTENSION_ID
	? process.env.VITAMINE_EXTENSION_ID.split(",").map((id) => id.trim())
	: ["bmmhpjecmacoeiglmdeiiblgecgempil"];

export const SERVER_ENTRY = join(import.meta.dir, "index.ts");
