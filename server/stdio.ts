import { alive, startDetached } from "./daemon";
import { BASE, LOG_FILE } from "./paths";
import { TOKEN } from "./token";

// Stdio front end for clients that only launch local MCP servers (Claude Desktop, `vitamine-mcp mcp`).
// It forwards each JSON-RPC line to the shared HTTP server, starting that server if nobody else has,
// so Desktop, Claude Code and the extension all meet on one process.
const log = (...args: unknown[]) => console.error("[vitamine]", ...args);

let starting: Promise<void> | null = null;

// Checked per request so a server that died gets restarted; concurrent requests share one spawn.
async function ensureServer() {
	if (await alive()) {
		return;
	}
	starting ??= startDetached()
		.then(() => log(`started server, logging to ${LOG_FILE}`))
		.finally(() => {
			starting = null;
		});
	return starting;
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
