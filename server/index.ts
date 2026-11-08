import { randomBytes } from "node:crypto";
import { bridge } from "./bridge";
import handleMcp from "./mcp";
import "./store";
import { authorized, proof, proofMatches, TOKEN_PATH } from "./token";

const PORT = Number(process.env.VITAMINE_PORT ?? 9333);
// Blocks DNS-rebinding: only requests addressed to localhost itself are served.
const HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
// Pinned by the `key` in extension/manifest.json. Origin is only a first filter (local processes can
// forge it); the HMAC handshake below is what actually proves the other side holds the token.
const EXTENSION_ORIGIN = `chrome-extension://${process.env.VITAMINE_EXTENSION_ID ?? "bmmhpjecmacoeiglmdeiiblgecgempil"}`;
const HANDSHAKE_MS = 5_000;

type Socket = { nonce: string; authed: boolean; timer?: Timer };

const unauthorized = () =>
	new Response("Unauthorized", {
		status: 401,
		headers: { "WWW-Authenticate": 'Bearer realm="vitamine"' },
	});

Bun.serve<Socket>({
	hostname: "127.0.0.1",
	port: PORT,
	idleTimeout: 255, // long scripts keep the MCP request open
	fetch(req, server) {
		if (!HOSTS.has(req.headers.get("host") ?? "")) {
			return new Response("Forbidden host", { status: 403 });
		}

		const { pathname } = new URL(req.url);

		if (pathname === "/ext") {
			if (req.headers.get("origin") !== EXTENSION_ORIGIN) {
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
				connected: bridge.connected,
				extension: bridge.info,
			});
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
			bridge.open(ws, { version: hello.version, userAgent: hello.userAgent });
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

console.log(
	`Vitamine on http://127.0.0.1:${PORT}: MCP at /mcp, extension socket at /ext. Token: ${TOKEN_PATH}`,
);
