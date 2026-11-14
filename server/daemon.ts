import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import { BASE, HOME, LOG_FILE, PID_FILE, SERVER_ENTRY } from "./paths";

export type Health = {
	vitamine?: boolean;
	pid?: number;
	connected: boolean;
	extension: { version?: string; userAgent?: string; connectedAt?: number };
};

export async function health(): Promise<Health | null> {
	try {
		const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1500) });
		return res.ok ? ((await res.json()) as Health) : null;
	} catch {
		return null;
	}
}

export const alive = async () => (await health()) !== null;

export async function waitFor(check: () => Promise<boolean>, ms: number) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await check()) return true;
		await Bun.sleep(150);
	}
	return false;
}

/** Starts the server as a detached process that outlives whoever started it. */
export async function startDetached() {
	mkdirSync(HOME, { recursive: true, mode: 0o700 });
	const out = openSync(LOG_FILE, "a");
	spawn(process.execPath, ["run", SERVER_ENTRY], {
		detached: true,
		stdio: ["ignore", out, out],
		env: process.env,
	}).unref();

	if (!(await waitFor(alive, 5000)))
		throw new Error(`Vitamine server did not come up on ${BASE}; see ${LOG_FILE}`);
}

export function serverPid() {
	if (!existsSync(PID_FILE)) return null;
	const pid = Number(readFileSync(PID_FILE, "utf8").trim());
	return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** Stops a server started outside the OS service manager. Returns false if none was running. */
export async function stopDetached() {
	const pid = serverPid();
	if (pid === null) return false;
	try {
		process.kill(pid, "SIGTERM");
	} catch {
		rmSync(PID_FILE, { force: true });
		return false;
	}
	await waitFor(async () => !(await alive()), 3000);
	return true;
}
