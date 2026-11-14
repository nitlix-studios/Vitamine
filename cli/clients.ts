import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// Registers Vitamine with the MCP clients we know how to configure. Each one launches
// `vitamine-mcp mcp` over stdio, which reads the token from disk, so no secret lands in their config.

export const MCP_COMMAND = [process.execPath, "run", join(import.meta.dir, "index.ts"), "mcp"];
const NAME = "vitamine";

export type Outcome = { client: string; result: "added" | "exists" | "duplicate" | "skipped" | "failed"; note?: string };

const run = (cmd: string, args: string[]) => spawnSync(cmd, args, { encoding: "utf8" });
const works = (cmd: string) => !run(cmd, ["--version"]).error;

function desktopDir() {
	if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "Claude");
	if (process.platform === "win32")
		return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Claude");
	return join(homedir(), ".config", "Claude");
}

// Newest copy of Claude Code that Claude Desktop keeps for its Code tab, which never lands on PATH.
function desktopBundledClaude() {
	const root = join(desktopDir(), "claude-code");
	if (!existsSync(root)) return null;
	const byVersion = (a: string, b: string) => b.localeCompare(a, undefined, { numeric: true });
	for (const version of readdirSync(root).sort(byVersion)) {
		for (const build of readdirSync(join(root, version))) {
			const candidates = [
				join(root, version, build, "claude.app", "Contents", "MacOS", "claude"),
				join(root, version, build, "claude"),
				join(root, version, build, "claude.exe"),
			];
			const found = candidates.find(existsSync);
			if (found) return found;
		}
	}
	return null;
}

/** Finds the `claude` CLI: PATH, the usual install locations, then Claude Desktop's own copy. */
export function findClaude() {
	const home = homedir();
	const exe = process.platform === "win32" ? "claude.exe" : "claude";
	const candidates = [
		join(home, ".claude", "local", exe),
		join(home, ".local", "bin", exe),
		join(home, ".bun", "bin", exe),
		join(home, ".npm-global", "bin", exe),
		"/opt/homebrew/bin/claude",
		"/usr/local/bin/claude",
	];
	if (works("claude")) return "claude";
	return candidates.find((path) => existsSync(path) && works(path)) ?? desktopBundledClaude();
}

function claudeCode(): Outcome {
	const client = "Claude Code";
	const claude = findClaude();
	if (!claude) return { client, result: "skipped", note: "not installed" };

	if (run(claude, ["mcp", "get", NAME]).status === 0) return { client, result: "exists" };

	const [command, ...args] = MCP_COMMAND;
	const add = run(claude, ["mcp", "add", "--scope", "user", NAME, "--", command!, ...args]);
	if (add.status !== 0) return { client, result: "failed", note: (add.stderr || add.stdout).trim() };
	return { client, result: "added" };
}

const desktopConfigPath = () => join(desktopDir(), "claude_desktop_config.json");

// A Vitamine .mcpb installed through Settings → Extensions already covers Desktop.
function desktopExtension() {
	const dir = join(desktopDir(), "Claude Extensions");
	if (!existsSync(dir)) return null;
	return readdirSync(dir).find((name) => /vitamine/i.test(name)) ?? null;
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
	const existing = Object.keys(config.mcpServers).find((key) => key.toLowerCase() === NAME);
	const extension = desktopExtension();
	if (existing && extension)
		return {
			client,
			result: "duplicate",
			note: "in claude_desktop_config.json and as an extension. Remove the extension in Settings → Extensions",
		};
	if (existing) return { client, result: "exists" };
	if (extension) return { client, result: "exists", note: "as an extension" };

	const [command, ...args] = MCP_COMMAND;
	config.mcpServers[NAME] = { command, args };
	writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
	return { client, result: "added", note: "restart Claude Desktop to load it" };
}

export const registerClients = () => [claudeCode(), claudeDesktop()];

/** Removes the entries `install` added. Returns the clients it removed Vitamine from. */
export function unregisterClients() {
	const removed: string[] = [];

	const claude = findClaude();
	if (claude && run(claude, ["mcp", "remove", "--scope", "user", NAME]).status === 0)
		removed.push("Claude Code");

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
