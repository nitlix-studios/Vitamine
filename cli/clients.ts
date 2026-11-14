import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// Registers Vitamine with the MCP clients we know how to configure. Each one launches
// `vitamine-mcp mcp` over stdio, which reads the token from disk, so no secret lands in their config.

export const MCP_COMMAND = [process.execPath, "run", join(import.meta.dir, "index.ts"), "mcp"];
const NAME = "vitamine";

export type Outcome = { client: string; result: "added" | "exists" | "skipped" | "failed"; note?: string };

function claudeCode(): Outcome {
	const client = "Claude Code";
	const which = spawnSync("claude", ["--version"], { encoding: "utf8" });
	if (which.error) return { client, result: "skipped", note: "`claude` isn't on PATH" };

	if (spawnSync("claude", ["mcp", "get", NAME], { encoding: "utf8" }).status === 0)
		return { client, result: "exists" };

	const [command, ...args] = MCP_COMMAND;
	const add = spawnSync("claude", ["mcp", "add", "--scope", "user", NAME, "--", command!, ...args], {
		encoding: "utf8",
	});
	if (add.status !== 0) return { client, result: "failed", note: (add.stderr || add.stdout).trim() };
	return { client, result: "added" };
}

function desktopConfigPath() {
	if (process.platform === "darwin")
		return join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
	if (process.platform === "win32")
		return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
	return join(homedir(), ".config", "Claude", "claude_desktop_config.json");
}

function claudeDesktop(): Outcome {
	const client = "Claude Desktop";
	const path = desktopConfigPath();
	if (!existsSync(dirname(path))) return { client, result: "skipped", note: "not installed" };

	let config: { mcpServers?: Record<string, unknown> } = {};
	if (existsSync(path)) {
		try {
			config = JSON.parse(readFileSync(path, "utf8"));
		} catch {
			return { client, result: "failed", note: `couldn't parse ${path}` };
		}
	}
	config.mcpServers ??= {};
	if (NAME in config.mcpServers) return { client, result: "exists" };

	const [command, ...args] = MCP_COMMAND;
	config.mcpServers[NAME] = { command, args };
	writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
	return { client, result: "added", note: "restart Claude Desktop to load it" };
}

export const registerClients = () => [claudeCode(), claudeDesktop()];

/** Removes the entries `install` added. Returns the clients it removed Vitamine from. */
export function unregisterClients() {
	const removed: string[] = [];

	const code = spawnSync("claude", ["mcp", "remove", "--scope", "user", NAME], { encoding: "utf8" });
	if (!code.error && code.status === 0) removed.push("Claude Code");

	const path = desktopConfigPath();
	if (!existsSync(path)) return removed;
	try {
		const config = JSON.parse(readFileSync(path, "utf8"));
		if (config.mcpServers?.[NAME]) {
			delete config.mcpServers[NAME];
			writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
			removed.push("Claude Desktop");
		}
	} catch {}
	return removed;
}
