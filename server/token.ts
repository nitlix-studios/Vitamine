import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOME } from "./paths";

// One secret shared by the server, MCP clients (as a Bearer token) and the extension, which gets it
// once through `vitamine-mcp pair` and keeps it in chrome.storage.
export const TOKEN_PATH = process.env.VITAMINE_TOKEN_FILE ?? join(HOME, "token");

function loadToken() {
	if (process.env.VITAMINE_TOKEN) {
		return process.env.VITAMINE_TOKEN;
	}

	if (existsSync(TOKEN_PATH)) {
		return readFileSync(TOKEN_PATH, "utf8").trim();
	}

	mkdirSync(join(TOKEN_PATH, ".."), { recursive: true, mode: 0o700 });
	const token = randomBytes(32).toString("base64url");
	writeFileSync(TOKEN_PATH, `${token}\n`, { mode: 0o600 });
	return token;
}

export const TOKEN = loadToken();

/** Replaces the token on disk. Running servers and MCP clients keep the old one until restarted. */
export function rotateToken() {
	mkdirSync(join(TOKEN_PATH, ".."), { recursive: true, mode: 0o700 });
	writeFileSync(TOKEN_PATH, `${randomBytes(32).toString("base64url")}\n`, { mode: 0o600 });
}

const same = (a: string, b: string) => {
	const x = Buffer.from(a);
	const y = Buffer.from(b);
	return x.length === y.length && timingSafeEqual(x, y);
};

/** Checks an `Authorization: Bearer <token>` header. */
export function authorized(req: Request) {
	const header = req.headers.get("authorization") ?? "";
	return same(header, `Bearer ${TOKEN}`);
}

/** HMAC proof for the extension handshake; each side signs the other's nonce with its own label. */
export const proof = (label: "ext" | "srv", nonce: string) =>
	createHmac("sha256", TOKEN).update(`${label}:${nonce}`).digest("hex");

export const proofMatches = (label: "ext" | "srv", nonce: string, given: unknown) =>
	typeof given === "string" && same(given, proof(label, nonce));
