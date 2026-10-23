import { bridge } from "./bridge";
import handleMcp from "./mcp";
import "./store";

const PORT = Number(process.env.VITAMINE_PORT ?? 9333);
// Blocks DNS-rebinding: only requests addressed to localhost itself are served.
const HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

Bun.serve({
	hostname: "127.0.0.1",
	port: PORT,
	idleTimeout: 255, // long scripts keep the MCP request open
	fetch(req, server) {
		if (!HOSTS.has(req.headers.get("host") ?? "")) {
			return new Response("Forbidden host", { status: 403 });
		}

		const { pathname } = new URL(req.url);

		if (pathname === "/ext") {
			if (!req.headers.get("origin")?.startsWith("chrome-extension://")) {
				return new Response("Forbidden", { status: 403 });
			}
			if (server.upgrade(req)) return;
			return new Response("Upgrade failed", { status: 400 });
		}

		if (pathname === "/mcp") {
			return handleMcp(req);
		}

		// Dev helper: `curl -X POST localhost:9333/reload-extension` after `bun run build`.
		if (
			pathname === "/reload-extension" &&
			req.method === "POST" &&
			!req.headers.get("origin")
		) {
			return bridge.call("reload").then(
				() => Response.json({ reloading: true }),
				(error: Error) =>
					Response.json({ error: error.message }, { status: 503 }),
			);
		}

		if (pathname === "/health") {
			return Response.json({
				connected: bridge.connected,
				extension: bridge.info,
			});
		}

		return new Response("Not found", { status: 404 });
	},
	websocket: {
		idleTimeout: 120,
		open(ws) {
			bridge.open(ws);
			console.log("extension connected");
		},
		message(_ws, message) {
			bridge.message(message);
		},
		close(ws) {
			bridge.close(ws);
			console.log("extension disconnected");
		},
	},
});

console.log(
	`Vitamine on http://127.0.0.1:${PORT}: MCP at /mcp, extension socket at /ext`,
);
