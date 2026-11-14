#!/usr/bin/env bun
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import pkg from "../package.json";
import { alive, health, startDetached, stopDetached, waitFor } from "../server/daemon";
import { BASE, HOME, LOG_FILE, SCRIPTS_DIR } from "../server/paths";
import { rotateToken, TOKEN_PATH } from "../server/token";
import { MCP_COMMAND, registerClients, unregisterClients } from "./clients";
import {
	autostartInstalled,
	autostartSupported,
	installAutostart,
	removeAutostart,
	startService,
	stopService,
} from "./service";

const EXTENSION_URL = "https://github.com/nitlix-studios/Vitamine#install-the-extension";

const color = (code: number) => (text: string) =>
	process.stdout.isTTY ? `\x1b[${code}m${text}\x1b[0m` : text;
const bold = color(1);
const dim = color(2);
const green = color(32);
const red = color(31);
const yellow = color(33);
const cyan = color(36);

const ok = (text: string) => console.log(`${green("✓")} ${text}`);
const warn = (text: string) => console.log(`${yellow("!")} ${text}`);
const fail = (text: string): never => {
	console.error(`${red("✗")} ${text}`);
	process.exit(1);
};
const tilde = (path: string) => path.replace(homedir(), "~");

const HELP = `${bold("vitamine-mcp")} ${dim(pkg.version)}  Let your AI agent drive your real browser.

${bold("Setup")}
  install          Start at login, register with Claude Code / Desktop, then pair
                   ${dim("--no-autostart  --no-clients  --no-pair  --browser <name>")}
  pair             Link the browser extension to this computer
                   ${dim("--browser <name>  open the pair page in a specific browser")}
  uninstall        Remove autostart and client registrations (keeps ~/.vitamine)

${bold("Server")}
  start            Start the server in the background
  stop             Stop it
  restart          Restart it
  status           Server, autostart and extension status
  logs             Show the server log ${dim("(-f to follow)")}

${bold("Advanced")}
  serve            Run the server in the foreground
  mcp              Stdio MCP bridge, for clients that launch a command
  rotate-token     Issue a new token, restart and re-pair

Docs: https://github.com/nitlix-studios/Vitamine`;

const args = process.argv.slice(2);
const command = args[0];
const has = (flag: string) => args.includes(flag);
const option = (flag: string) => {
	const index = args.indexOf(flag);
	return index === -1 ? undefined : args[index + 1];
};

// Starts the server through the OS service if one is installed, otherwise as a detached process.
async function ensureRunning() {
	if (await alive()) return;
	if (!autostartInstalled()) {
		await startDetached();
		return;
	}
	startService();
	if (!(await waitFor(alive, 5000)))
		fail(`The server didn't start. See ${tilde(LOG_FILE)}`);
}

async function stopServer() {
	if (autostartInstalled()) stopService();
	await stopDetached();
	return waitFor(async () => !(await alive()), 3000);
}

function openUrl(url: string, browser?: string) {
	const [cmd, ...cmdArgs] =
		process.platform === "darwin"
			? ["open", ...(browser ? ["-a", browser] : []), url]
			: process.platform === "win32"
				? ["cmd", "/c", "start", '""', browser ?? "", url].filter(Boolean)
				: browser
					? [browser, url]
					: ["xdg-open", url];
	return spawnSync(cmd!, cmdArgs, { stdio: "ignore" }).status === 0;
}

const browserName = (ua = "") => {
	const match = /(Edg|OPR|Vivaldi|Brave|Chrome)\/(\d+)/.exec(ua);
	const names: Record<string, string> = { Edg: "Edge", OPR: "Opera" };
	return match ? `${names[match[1]!] ?? match[1]} ${match[2]}` : "browser";
};

async function pair() {
	await ensureRunning();
	const token = process.env.VITAMINE_TOKEN ?? readFileSync(TOKEN_PATH, "utf8").trim();
	const before = (await health())?.extension.connectedAt ?? 0;
	const url = `${BASE}/pair#${token}`;

	if (!openUrl(url, option("--browser"))) {
		warn("Couldn't open a browser. Open this link in the browser with Vitamine installed:");
		console.log(`  ${cyan(url)}`);
	} else {
		console.log(`${cyan("→")} Opened the pair page. Waiting for the extension… ${dim("(Ctrl+C to stop)")}`);
	}

	const linked = await waitFor(
		async () => ((await health())?.extension.connectedAt ?? 0) > before,
		180_000,
	);
	if (!linked)
		fail(`Timed out. Install the extension (${EXTENSION_URL}) and run \`vitamine-mcp pair\` again.`);

	const info = (await health())?.extension;
	ok(`Browser linked ${dim(`(Vitamine ${info?.version} in ${browserName(info?.userAgent)})`)}`);
}

// bunx runs from a temp cache that gets cleaned up, which would break autostart and client configs.
// Install globally first and hand over to the global copy.
function handOffToGlobal() {
	if (!/[\\/]bunx-|[\\/]install[\\/]cache[\\/]/.test(import.meta.dir)) return;

	console.log(`${cyan("→")} Installing vitamine-mcp@${pkg.version} globally…`);
	const add = spawnSync(process.execPath, ["add", "-g", `vitamine-mcp@${pkg.version}`], {
		stdio: "inherit",
	});
	if (add.status !== 0) fail("`bun add -g vitamine-mcp` failed");

	const bin = spawnSync(process.execPath, ["pm", "bin", "-g"], { encoding: "utf8" }).stdout.trim();
	const exe = `${bin}/vitamine-mcp${process.platform === "win32" ? ".exe" : ""}`;
	const result = spawnSync(existsSync(exe) ? exe : "vitamine-mcp", args, { stdio: "inherit" });
	process.exit(result.status ?? 1);
}

async function install() {
	handOffToGlobal();
	console.log(`${bold("Vitamine")} ${dim(pkg.version)}\n`);

	if (!has("--no-autostart") && autostartSupported) {
		// A server started some other way would hold the port; the service takes over from here.
		await stopDetached();
		const file = installAutostart();
		if (!(await waitFor(alive, 5000))) fail(`The server didn't start. See ${tilde(LOG_FILE)}`);
		ok(`Server running, starts at login ${dim(tilde(file))}`);
	} else {
		await ensureRunning();
		ok(`Server running ${dim(BASE)}`);
		if (!autostartSupported) warn("Autostart isn't available on this platform; MCP clients start the server on demand.");
	}

	if (!has("--no-clients")) {
		for (const { client, result, note } of registerClients()) {
			const suffix = note ? dim(` (${note})`) : "";
			if (result === "added") ok(`Added to ${client}${suffix}`);
			if (result === "exists") ok(`${client} already has it`);
			if (result === "failed") warn(`Couldn't add to ${client}${suffix}`);
			if (result === "skipped") console.log(dim(`- ${client}: ${note}`));
		}
	}

	console.log(
		`\n${bold("Extension")}  If you haven't yet, install it: ${cyan(EXTENSION_URL)}\n` +
			`Then turn on ${bold("Allow User Scripts")} on its Details page.\n`,
	);

	if (has("--no-pair")) {
		console.log(`Run ${bold("vitamine-mcp pair")} once the extension is installed.`);
		return;
	}
	await pair();
	console.log(`\n${green("Done.")} Ask your agent to do something in your browser.`);
}

async function uninstall() {
	const removedService = removeAutostart();
	if (removedService) ok(`Removed autostart ${dim(tilde(removedService))}`);
	await stopDetached();
	for (const client of unregisterClients()) ok(`Removed from ${client}`);
	console.log(dim(`Your token and saved scripts are still in ${tilde(HOME)}. Delete that folder to remove them.`));
}

async function status() {
	const state = await health();
	const row = (label: string, value: string) => console.log(`  ${label.padEnd(11)}${value}`);

	console.log(`${bold("Vitamine")} ${dim(pkg.version)}`);
	row(
		"Server",
		state ? `${green("running")} ${dim(`pid ${state.pid ?? "?"} · ${BASE}`)}` : red("stopped"),
	);
	row(
		"Autostart",
		autostartInstalled() ? green("on") : autostartSupported ? dim("off (vitamine-mcp install)") : dim("n/a"),
	);
	row(
		"Extension",
		state?.connected
			? `${green("connected")} ${dim(`Vitamine ${state.extension.version} · ${browserName(state.extension.userAgent)}`)}`
			: state
				? `${yellow("not connected")} ${dim("(vitamine-mcp pair)")}`
				: dim("-"),
	);
	row("Token", dim(tilde(TOKEN_PATH)));
	row("Scripts", dim(tilde(SCRIPTS_DIR)));
	row("MCP", dim(`${BASE}/mcp  or  ${MCP_COMMAND.map(tilde).join(" ")}`));
}

function logs() {
	if (!existsSync(LOG_FILE)) fail(`No log yet at ${tilde(LOG_FILE)}`);
	if (process.platform === "win32") {
		console.log(readFileSync(LOG_FILE, "utf8"));
		return;
	}
	spawn("tail", ["-n", "100", ...(has("-f") ? ["-f"] : []), LOG_FILE], { stdio: "inherit" });
}

switch (command) {
	case "install":
		await install();
		break;
	case "uninstall":
		await uninstall();
		break;
	case "pair":
		await pair();
		break;
	case "start":
		await ensureRunning();
		ok(`Server running ${dim(BASE)}`);
		break;
	case "stop":
		if (!(await alive())) {
			console.log("Not running.");
			break;
		}
		if (!(await stopServer())) fail("The server didn't stop. Is it running from a terminal (`bun run dev`)?");
		ok("Stopped");
		break;
	case "restart":
		await stopServer();
		await ensureRunning();
		ok(`Restarted ${dim(BASE)}`);
		break;
	case "status":
		await status();
		break;
	case "logs":
		logs();
		break;
	case "serve":
		await import("../server/index");
		break;
	case "mcp":
		await import("../server/stdio");
		break;
	case "rotate-token":
		rotateToken();
		ok(`New token written to ${tilde(TOKEN_PATH)}`);
		await stopServer();
		await ensureRunning();
		ok("Server restarted. MCP clients pick up the new token when they restart.");
		await pair();
		break;
	case "-v":
	case "--version":
	case "version":
		console.log(pkg.version);
		break;
	case undefined:
	case "-h":
	case "--help":
	case "help":
		console.log(HELP);
		break;
	default:
		console.error(`Unknown command "${command}"\n`);
		console.log(HELP);
		process.exit(1);
}
