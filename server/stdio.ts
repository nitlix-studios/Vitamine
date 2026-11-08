import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { TOKEN, TOKEN_PATH } from "./token";

// Stdio front end for clients that only launch local MCP servers (Claude Desktop, .mcpb).
// It forwards each JSON-RPC line to the shared HTTP server, starting that server if nobody else has,
// so Desktop, Claude Code and the extension all meet on one process.
const PORT = Number(process.env.VITAMINE_PORT ?? 9333);
const BASE = `http://127.0.0.1:${PORT}`;
const LOG = join(TOKEN_PATH, "..", "server.log");

const log = (...args: unknown[]) => console.error("[vitamine]", ...args);

async function alive() {
	try {
		return (await fetch(`${BASE}/health`)).ok;
	} catch {
		return false;
	}
}

let starting: Promise<void> | null = null;

// Checked per request so a server that died gets restarted; concurrent requests share one spawn.
async function ensureServer() {
	if (await alive()) {
		return;
	}
	starting ??= startServer().finally(() => {
		starting = null;
	});
	return starting;
}

async function startServer() {
	mkdirSync(join(LOG, ".."), { recursive: true });
	const out = openSync(LOG, "a");
	// Detached so it outlives this client and keeps serving the others.
	spawn(process.execPath, ["run", join(import.meta.dir, "index.ts")], {
		detached: true,
		stdio: ["ignore", out, out],
		env: process.env,
	}).unref();
	log(`started server, logging to ${LOG}`);

	for (let i = 0; i < 50; i++) {
		await Bun.sleep(100);
		if (await alive()) {
			return;
		}
	}
	throw new Error(`Vitamine server did not come up on ${BASE}; see ${LOG}`);
}

async function forward(line: string) {
	let id: unknown = null;
	try {
		id = JSON.parse(line)?.id ?? null;
	} catch {}

	try {
		await ensureServer();
		const res = await fetch(`${BASE}/mcp`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				authorization: `Bearer ${TOKEN}`,
			},
			body: line,
		});
		const text = (await res.text()).trim();
		// Notifications come back as 202 with no body.
		if (!text) {
			return;
		}
		process.stdout.write(`${text}\n`);
	} catch (error) {
		log(error);
		if (id === null) {
			return;
		}
		process.stdout.write(
			`${JSON.stringify({
				jsonrpc: "2.0",
				id,
				error: { code: -32603, message: String((error as Error).message ?? error) },
			})}\n`,
		);
	}
}

ensureServer().catch(log);

// Lines are handled concurrently so a long `run` doesn't block pings or other calls.
for await (const line of console) {
	if (line.trim()) {
		forward(line);
	}
}
