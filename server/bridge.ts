import type { ServerWebSocket } from "bun";

type Pending = {
	resolve: (value: any) => void;
	reject: (error: Error) => void;
	timer: Timer;
};

export type BrowserEvent = { tabId: number; method: string; params: any };

/** chrome.debugger refused the tab, usually because another extension has a frame in it. */
export class BlockedError extends Error {}

const BLOCKED =
	/chrome-extension:\/\/ URL of different extension|Detached while handling|Cannot attach to this target/;

// Owns the single WebSocket from the extension and turns it into request/response calls.
class Bridge {
	private socket: ServerWebSocket<unknown> | null = null;
	private pending = new Map<number, Pending>();
	private nextId = 1;
	private listeners = new Set<(event: BrowserEvent) => void>();
	info: { version?: string; userAgent?: string } = {};

	get connected() {
		return this.socket !== null;
	}

	open(ws: ServerWebSocket<unknown>) {
		this.socket?.close(4000, "Replaced by a newer connection");
		this.socket = ws;
	}

	close(ws: ServerWebSocket<unknown>) {
		if (this.socket !== ws) {
			return;
		}

		this.socket = null;
		this.info = {};
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(new Error("Extension disconnected"));
		}
		this.pending.clear();
	}

	message(raw: string | Buffer) {
		let msg: any;
		try {
			msg = JSON.parse(String(raw));
		} catch {
			return;
		}

		if (msg.type === "hello") {
			this.info = { version: msg.version, userAgent: msg.userAgent };
			return;
		}

		if (msg.type === "event") {
			for (const listener of this.listeners) listener(msg);
			return;
		}

		const pending =
			typeof msg.id === "number" ? this.pending.get(msg.id) : undefined;
		if (!pending) {
			return;
		}

		this.pending.delete(msg.id);
		clearTimeout(pending.timer);
		if (msg.ok) pending.resolve(msg.result);
		else pending.reject(new Error(msg.error));
	}

	call<T = any>(
		cmd: string,
		params: Record<string, unknown> = {},
		timeoutMs = 30_000,
	): Promise<T> {
		const socket = this.socket;
		if (!socket) {
			return Promise.reject(
				new Error(
					"Vitamine extension is not connected. Load the extension folder in the browser; its badge should say ON.",
				),
			);
		}

		const id = this.nextId++;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(
					new Error(
						`${cmd === "cdp" ? params.method : cmd} timed out after ${timeoutMs}ms`,
					),
				);
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			socket.send(JSON.stringify({ id, cmd, params }));
		});
	}

	cdp<T = any>(
		tabId: number,
		method: string,
		params: Record<string, unknown> = {},
		timeoutMs?: number,
	) {
		return this.call<T>("cdp", { tabId, method, params }, timeoutMs).catch(
			(error: Error) => {
				if (!BLOCKED.test(error.message)) throw error;
				throw new BlockedError(
					`Chrome won't let Vitamine debug tab ${tabId}: another extension (usually a password manager's inline menu) has a frame in it. Network, console and full-page screenshots need the debugger. (${error.message})`,
				);
			},
		);
	}

	on(listener: (event: BrowserEvent) => void) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
}

export const bridge = new Bridge();
