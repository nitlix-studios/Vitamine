// Thin relay: the Vitamine server sends commands over a WebSocket, this worker runs them with
// chrome.tabs / chrome.debugger and streams DevTools events back.

const SERVER = "ws://127.0.0.1:9333/ext";
const VERSION = chrome.runtime.getManifest().version;
const DOMAINS = ["Network.enable", "Runtime.enable", "Page.enable"];
const FORWARD = new Set([
	"Network.requestWillBeSent",
	"Network.responseReceived",
	"Network.loadingFinished",
	"Network.loadingFailed",
	"Runtime.consoleAPICalled",
	"Runtime.exceptionThrown",
]);

type Command = { id: number; cmd: string; params?: Record<string, any> };
type Clip = { x: number; y: number; w: number; h: number };

const USER_SCRIPTS_OFF =
	'Fallback mode needs user scripts: open Vitamine\'s Details page in the extensions list and turn on "Allow User Scripts"';

let socket: WebSocket | null = null;
const attached = new Set<number>();
const attaching = new Map<number, Promise<void>>();

// Tabs Vitamine opened, plus tabs those opened. Stored so worker restarts and extension reloads keep
// them; tab ids reset when the browser restarts, so the list is cleared on startup.
const agentTabs = new Set<number>();
// The active tab per window and the one before it, to undo focus stolen by popups.
const activeByWindow = new Map<
	number,
	{ current?: number; previous?: number }
>();

const ready = (async () => {
	const { agentTabs: saved } = await chrome.storage.local.get("agentTabs");
	const open = new Set((await chrome.tabs.query({})).map((tab) => tab.id));
	for (const id of (saved as number[] | undefined) ?? [])
		if (open.has(id)) agentTabs.add(id);
	for (const tab of await chrome.tabs.query({ active: true })) {
		if (tab.id !== undefined && !activeByWindow.has(tab.windowId))
			activeByWindow.set(tab.windowId, { current: tab.id });
	}
})();
const saveAgentTabs = () =>
	chrome.storage.local.set({ agentTabs: [...agentTabs] });
const groupByWindow = new Map<number, number>();
// Which tab a popup came from. Chrome's openerTabId names the tab that was showing, not the
// background tab that was clicked, so popups are attributed to Vitamine's latest input instead.
const openedFrom = new Map<number, number>();
let lastInput: { tabId: number; time: number } | undefined;
const POPUP_WINDOW_MS = 3_000;

function send(message: unknown) {
	if (socket?.readyState !== WebSocket.OPEN) {
		return;
	}
	socket.send(JSON.stringify(message));
}

function setBadge(on: boolean) {
	chrome.action.setBadgeText({ text: on ? "ON" : "OFF" });
	chrome.action.setBadgeBackgroundColor({
		color: on ? "#16a34a" : "#737373",
	});
}

function connect() {
	if (socket && socket.readyState !== WebSocket.CLOSED) {
		return;
	}

	const ws = new WebSocket(SERVER);
	socket = ws;
	ws.onopen = () => {
		setBadge(true);
		send({
			type: "hello",
			version: VERSION,
			userAgent: navigator.userAgent,
		});
	};
	ws.onmessage = (event) => handle(JSON.parse(event.data));
	ws.onclose = () => {
		if (socket === ws) socket = null;
		setBadge(false);
		setTimeout(connect, 2000);
	};
}

const tabInfo = (tab: chrome.tabs.Tab) => ({
	id: tab.id,
	windowId: tab.windowId,
	active: tab.active,
	title: tab.title ?? "",
	url: tab.url ?? tab.pendingUrl ?? "",
	status: tab.status,
	openerTabId:
		(tab.id !== undefined && openedFrom.get(tab.id)) || tab.openerTabId,
	agent: tab.id !== undefined && agentTabs.has(tab.id),
});

// Agent tabs live in one "Vitamine" group per window so they're easy to spot and close.
async function addToGroup(tab: chrome.tabs.Tab) {
	if (tab.id === undefined) return;
	try {
		const existing = groupByWindow.get(tab.windowId);
		if (
			existing !== undefined &&
			(await chrome.tabGroups.get(existing).catch(() => null))
		) {
			await chrome.tabs.group({ tabIds: tab.id, groupId: existing });
			return;
		}
		const groupId = await chrome.tabs.group({
			tabIds: tab.id,
			createProperties: { windowId: tab.windowId },
		});
		groupByWindow.set(tab.windowId, groupId);
		await chrome.tabGroups.update(groupId, {
			title: "Vitamine",
			color: "cyan",
			collapsed: false,
		});
	} catch {
		// Grouping is cosmetic; browsers without tab groups still work.
	}
}

async function adopt(tab: chrome.tabs.Tab) {
	if (tab.id === undefined) return;
	agentTabs.add(tab.id);
	await saveAgentTabs();
	await addToGroup(tab);
}

function attach(tabId: number) {
	if (attached.has(tabId)) {
		return Promise.resolve();
	}

	let pending = attaching.get(tabId);
	if (pending) {
		return pending;
	}

	const work = (async () => {
		try {
			await chrome.debugger.attach({ tabId }, "1.3");
		} catch (error) {
			// After a worker restart our earlier session can still be alive; anything else is real.
			if (!String(error).includes("already attached")) throw error;
		}
		for (const method of DOMAINS)
			await chrome.debugger.sendCommand({ tabId }, method);
		attached.add(tabId);
	})();
	// A tab that never answers must not block every later call to it.
	const timeout = new Promise<never>((_, reject) =>
		setTimeout(
			() => reject(new Error(`Attaching to tab ${tabId} timed out`)),
			10_000,
		),
	);
	pending = Promise.race([work, timeout]).finally(() =>
		attaching.delete(tabId),
	);

	attaching.set(tabId, pending);
	return pending;
}

// Fallback for tabs chrome.debugger can't attach to: run code in the page's main world.
async function evaluate(tabId: number, code: string) {
	let results: chrome.userScripts.InjectionResult<unknown>[];
	try {
		results = await chrome.userScripts.execute({
			target: { tabId },
			world: "MAIN",
			js: [{ code }],
			injectImmediately: true,
		});
	} catch (error) {
		if (!chrome.userScripts || /user ?scripts/i.test(String(error)))
			throw new Error(`${USER_SCRIPTS_OFF} (${error})`);
		throw error;
	}
	const [first] = results;
	if (!first) throw new Error("Script did not run in the page");
	if (first.error) throw new Error(first.error);
	return first.result;
}

function toBase64(buffer: ArrayBuffer) {
	const bytes = new Uint8Array(buffer);
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000)
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(binary);
}

// captureVisibleTab only sees the tab showing in its window; clip is in viewport CSS pixels.
async function capture(
	tabId: number,
	clip: Clip,
	dpr: number,
	quality: number,
) {
	const tab = await chrome.tabs.get(tabId);
	if (!tab.active)
		throw new Error(
			"Fallback screenshots only work on the tab showing in its window; call tabs.activate(id) first",
		);
	const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
		format: "png",
	});
	const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
	const canvas = new OffscreenCanvas(
		Math.max(1, Math.round(clip.w)),
		Math.max(1, Math.round(clip.h)),
	);
	canvas
		.getContext("2d")!
		.drawImage(
			bitmap,
			clip.x * dpr,
			clip.y * dpr,
			clip.w * dpr,
			clip.h * dpr,
			0,
			0,
			canvas.width,
			canvas.height,
		);
	const blob = await canvas.convertToBlob({
		type: "image/jpeg",
		quality: quality / 100,
	});
	return toBase64(await blob.arrayBuffer());
}

async function run(cmd: string, p: Record<string, any>) {
	switch (cmd) {
		case "tabs.list":
			await ready;
			return (await chrome.tabs.query({})).map(tabInfo);
		case "tabs.active": {
			const [tab] = await chrome.tabs.query({
				active: true,
				lastFocusedWindow: true,
			});
			if (!tab?.id) throw new Error("No active tab");
			return tabInfo(tab);
		}
		case "tabs.create": {
			await ready;
			const tab = await chrome.tabs.create({
				url: p.url ?? "about:blank",
				active: p.active ?? false,
			});
			await adopt(tab);
			return tabInfo(tab);
		}
		case "tabs.close":
			await chrome.tabs.remove(p.tabId);
			return true;
		case "tabs.activate": {
			const tab = await chrome.tabs.update(p.tabId, { active: true });
			if (tab)
				await chrome.windows.update(tab.windowId, { focused: true });
			return true;
		}
		case "tabs.get":
			return tabInfo(await chrome.tabs.get(p.tabId));
		case "tabs.navigate":
			await chrome.tabs.update(p.tabId, { url: p.url });
			return true;
		case "tabs.reload":
			await chrome.tabs.reload(p.tabId);
			return true;
		case "tabs.back":
			await chrome.tabs.goBack(p.tabId);
			return true;
		case "tabs.forward":
			await chrome.tabs.goForward(p.tabId);
			return true;
		case "eval":
			if (/synth(Click|Key)/.test(p.code))
				lastInput = { tabId: p.tabId, time: Date.now() };
			return evaluate(p.tabId, p.code);
		case "capture":
			return capture(p.tabId, p.clip, p.dpr, p.quality ?? 70);
		case "cookies":
			return chrome.cookies.getAll(
				p.domain ? { domain: p.domain } : { url: p.url },
			);
		case "attach":
			await attach(p.tabId);
			return true;
		case "detach":
			attached.delete(p.tabId);
			await chrome.debugger.detach({ tabId: p.tabId }).catch(() => {});
			return true;
		case "reload":
			setTimeout(() => chrome.runtime.reload(), 100);
			return true;
		case "cdp":
			if (String(p.method).startsWith("Input."))
				lastInput = { tabId: p.tabId, time: Date.now() };
			await attach(p.tabId);
			return chrome.debugger.sendCommand(
				{ tabId: p.tabId },
				p.method,
				p.params ?? {},
			);
		default:
			throw new Error(`Unknown command "${cmd}"`);
	}
}

async function handle(message: Command) {
	try {
		const result = await run(message.cmd, message.params ?? {});
		send({ id: message.id, ok: true, result });
	} catch (error) {
		send({
			id: message.id,
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

chrome.debugger.onEvent.addListener((source, method, params) => {
	if (!source.tabId || !FORWARD.has(method)) {
		return;
	}
	send({ type: "event", tabId: source.tabId, method, params });
});

chrome.debugger.onDetach.addListener((source, reason) => {
	if (!source.tabId) {
		return;
	}
	attached.delete(source.tabId);
	send({
		type: "event",
		tabId: source.tabId,
		method: "Vitamine.detached",
		params: { reason },
	});
});

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
	const record = activeByWindow.get(windowId) ?? {};
	activeByWindow.set(windowId, { current: tabId, previous: record.current });
});

// A page Vitamine drives may open popups or target=_blank tabs. Adopt them and push them to the
// background so they never take over what the user is looking at.
chrome.tabs.onCreated.addListener(async (tab) => {
	await ready;
	if (tab.id === undefined) return;
	const recent =
		lastInput && Date.now() - lastInput.time < POPUP_WINDOW_MS
			? lastInput.tabId
			: undefined;
	const opener =
		recent ??
		(tab.openerTabId !== undefined && agentTabs.has(tab.openerTabId)
			? tab.openerTabId
			: undefined);
	if (opener === undefined) return;
	openedFrom.set(tab.id, opener);
	await adopt(tab);
	send({
		type: "event",
		tabId: tab.id,
		method: "Vitamine.tabOpened",
		params: { openerTabId: opener, url: tab.pendingUrl ?? tab.url },
	});
	if (!tab.active) return;

	// onActivated may land before or after onCreated; give it a moment, then restore the earlier tab.
	await new Promise((resolve) => setTimeout(resolve, 50));
	const record = activeByWindow.get(tab.windowId);
	const restore =
		record?.current === tab.id ? record.previous : record?.current;
	if (restore !== undefined && restore !== tab.id)
		await chrome.tabs.update(restore, { active: true }).catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
	attached.delete(tabId);
	openedFrom.delete(tabId);
	if (agentTabs.delete(tabId)) saveAgentTabs();
	send({ type: "event", tabId, method: "Vitamine.tabClosed", params: {} });
});

// Traffic every 20s keeps the MV3 worker alive; the alarm revives it if it was stopped anyway.
setInterval(() => send({ type: "ping" }), 20_000);
chrome.alarms.create("vitamine-reconnect", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(connect);
chrome.runtime.onStartup.addListener(() => {
	chrome.storage.local.remove("agentTabs");
	connect();
});
chrome.runtime.onInstalled.addListener(connect);

setBadge(false);
connect();
