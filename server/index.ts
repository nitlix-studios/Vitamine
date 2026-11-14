import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bridge } from "./bridge";
import { alive } from "./daemon";
import handleMcp from "./mcp";
import { BASE, EXTENSION_IDS, HOME, PID_FILE, PORT } from "./paths";
import "./store";
import { authorized, proof, proofMatches, TOKEN_PATH } from "./token";

// Blocks DNS-rebinding: only requests addressed to localhost itself are served.
const HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
// Origin is only a first filter (local processes can forge it); the HMAC handshake below is what
// actually proves the other side holds the token.
const EXTENSION_ORIGINS = new Set(EXTENSION_IDS.map((id) => `chrome-extension://${id}`));
// The token never goes into this page: `vitamine-mcp pair` puts it in the URL fragment, which the
// browser keeps to itself, and the page hands it straight to the extension.
const PAIR_PAGE = (await Bun.file(join(import.meta.dir, "pair.html")).text()).replace(
	"__EXTENSION_IDS__",
	JSON.stringify(EXTENSION_IDS),
);
const PAIR_HEADERS = {
	"content-type": "text/html; charset=utf-8",
	"cache-control": "no-store",
	"referrer-policy": "no-referrer",
	"x-frame-options": "DENY",
	"content-security-policy":
		"default-src 'none'; img-src data:; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'",
};

// Autostart and on-demand starts can race; whoever loses steps aside quietly.
if (await alive()) {
	console.log(`Vitamine is already running on ${BASE}`);
	process.exit(0);
}
const HANDSHAKE_MS = 5_000;

type Socket = { nonce: string; authed: boolean; timer?: Timer };

const unauthorized = () =>
	new Response("Unauthorized", {
		status: 401,
		headers: { "WWW-Authenticate": 'Bearer realm="vitamine"' },
	});

const server = Bun.serve<Socket>({
	hostname: "127.0.0.1",
	port: PORT,
	idleTimeout: 255, // long scripts keep the MCP request open
	fetch(req, server) {
		if (!HOSTS.has(req.headers.get("host") ?? "")) {
			return new Response("Forbidden host", { status: 403 });
		}

		const { pathname } = new URL(req.url);

		if (pathname === "/ext") {
			if (!EXTENSION_ORIGINS.has(req.headers.get("origin") ?? "")) {
				console.log(`rejected /ext origin: ${req.headers.get("origin")}`);
				return new Response("Forbidden", { status: 403 });
			}
			const data = { nonce: randomBytes(16).toString("hex"), authed: false };
			if (server.upgrade(req, { data })) return;
			return new Response("Upgrade failed", { status: 400 });
		}

		if (pathname === "/mcp") {
			if (!authorized(req)) return unauthorized();
			return handleMcp(req);
		}

		// Dev helper: see "Development" in the README.
		if (
			pathname === "/reload-extension" &&
			req.method === "POST" &&
			!req.headers.get("origin")
		) {
			if (!authorized(req)) return unauthorized();
			return bridge.call("reload").then(
				() => Response.json({ reloading: true }),
				(error: Error) =>
					Response.json({ error: error.message }, { status: 503 }),
			);
		}

		if (pathname === "/health") {
			return Response.json({
				vitamine: true,
				pid: process.pid,
				connected: bridge.connected,
				extension: bridge.info,
			});
		}

		if (pathname === "/pair") {
			return new Response(PAIR_PAGE, { headers: PAIR_HEADERS });
		}

		return new Response("Not found", { status: 404 });
	},
	websocket: {
		idleTimeout: 120,
		// Mutual challenge: the extension signs our nonce, then we sign its nonce so it knows it isn't
		// talking to some other process squatting on the port.
		open(ws) {
			ws.send(JSON.stringify({ type: "challenge", nonce: ws.data.nonce }));
			ws.data.timer = setTimeout(
				() => ws.close(4001, "Handshake timed out"),
				HANDSHAKE_MS,
			);
		},
		message(ws, message) {
			if (ws.data.authed) {
				bridge.message(message);
				return;
			}

			let hello: any;
			try {
				hello = JSON.parse(String(message));
			} catch {}
			if (
				hello?.type !== "hello" ||
				typeof hello.nonce !== "string" ||
				!proofMatches("ext", ws.data.nonce, hello.proof)
			) {
				ws.close(4003, "Bad handshake");
				return;
			}

			clearTimeout(ws.data.timer);
			ws.data.authed = true;
			ws.send(JSON.stringify({ type: "ready", proof: proof("srv", hello.nonce) }));
			bridge.open(ws, {
				version: hello.version,
				userAgent: hello.userAgent,
				connectedAt: Date.now(),
			});
			console.log("extension connected");
		},
		close(ws) {
			clearTimeout(ws.data.timer);
			if (!ws.data.authed) return;
			bridge.close(ws);
			console.log("extension disconnected");
		},
	},
});

mkdirSync(HOME, { recursive: true, mode: 0o700 });
writeFileSync(PID_FILE, `${process.pid}\n`);
const shutdown = () => {
	rmSync(PID_FILE, { force: true });
	server.stop(true);
	process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

console.log(
	`Vitamine on http://127.0.0.1:${PORT}: MCP at /mcp, extension socket at /ext. Token: ${TOKEN_PATH}`,
);
