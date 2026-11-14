import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { LOG_FILE, SERVER_ENTRY } from "../server/paths";

// Runs the server at login through the OS's own service manager: a LaunchAgent on macOS and a
// systemd user unit on Linux. Windows falls back to on-demand starts from MCP clients.

const LABEL = "dev.vitamine.server";
const PLIST = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const UNIT = join(homedir(), ".config", "systemd", "user", "vitamine.service");

const run = (cmd: string, args: string[]) => spawnSync(cmd, args, { encoding: "utf8" });
const uid = () => process.getuid?.() ?? 0;
const xml = (value: string) =>
	value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const autostartSupported = process.platform === "darwin" || process.platform === "linux";

export function autostartInstalled() {
	if (process.platform === "darwin") return existsSync(PLIST);
	if (process.platform === "linux") return existsSync(UNIT);
	return false;
}

/** Writes the service definition and starts it. Returns the file it wrote. */
export function installAutostart() {
	if (process.platform === "darwin") {
		mkdirSync(dirname(PLIST), { recursive: true });
		writeFileSync(
			PLIST,
			`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${LABEL}</string>
	<key>ProgramArguments</key>
	<array>
		<string>${xml(process.execPath)}</string>
		<string>run</string>
		<string>${xml(SERVER_ENTRY)}</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<dict>
		<key>SuccessfulExit</key>
		<false/>
	</dict>
	<key>StandardOutPath</key>
	<string>${xml(LOG_FILE)}</string>
	<key>StandardErrorPath</key>
	<string>${xml(LOG_FILE)}</string>
</dict>
</plist>
`,
		);
		run("launchctl", ["bootout", `gui/${uid()}/${LABEL}`]);
		const result = run("launchctl", ["bootstrap", `gui/${uid()}`, PLIST]);
		if (result.status !== 0) throw new Error(`launchctl bootstrap failed: ${result.stderr.trim()}`);
		return PLIST;
	}

	if (process.platform === "linux") {
		mkdirSync(dirname(UNIT), { recursive: true });
		writeFileSync(
			UNIT,
			`[Unit]
Description=Vitamine browser automation server

[Service]
ExecStart="${process.execPath}" run "${SERVER_ENTRY}"
Restart=on-failure
StandardOutput=append:${LOG_FILE}
StandardError=append:${LOG_FILE}

[Install]
WantedBy=default.target
`,
		);
		run("systemctl", ["--user", "daemon-reload"]);
		const result = run("systemctl", ["--user", "enable", "--now", "vitamine.service"]);
		if (result.status !== 0) throw new Error(`systemctl enable failed: ${result.stderr.trim()}`);
		return UNIT;
	}

	throw new Error("Autostart isn't supported on this platform yet");
}

export function removeAutostart() {
	if (process.platform === "darwin" && existsSync(PLIST)) {
		run("launchctl", ["bootout", `gui/${uid()}/${LABEL}`]);
		rmSync(PLIST);
		return PLIST;
	}
	if (process.platform === "linux" && existsSync(UNIT)) {
		run("systemctl", ["--user", "disable", "--now", "vitamine.service"]);
		rmSync(UNIT);
		run("systemctl", ["--user", "daemon-reload"]);
		return UNIT;
	}
	return null;
}

/** Starts the installed service. */
export function startService() {
	if (process.platform === "darwin") {
		const result = run("launchctl", ["bootstrap", `gui/${uid()}`, PLIST]);
		// Already loaded: make sure it's running.
		if (result.status !== 0) run("launchctl", ["kickstart", `gui/${uid()}/${LABEL}`]);
		return;
	}
	run("systemctl", ["--user", "start", "vitamine.service"]);
}

/** Stops the installed service until the next login or `start`. */
export function stopService() {
	if (process.platform === "darwin") {
		run("launchctl", ["bootout", `gui/${uid()}/${LABEL}`]);
		return;
	}
	run("systemctl", ["--user", "stop", "vitamine.service"]);
}
