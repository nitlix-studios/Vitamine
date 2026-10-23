import { bridge } from "./bridge";

export type NetEntry = {
	id: string;
	tabId: number;
	method: string;
	url: string;
	type?: string;
	status?: number;
	statusText?: string;
	mimeType?: string;
	requestHeaders: Record<string, string>;
	responseHeaders?: Record<string, string>;
	postData?: string;
	hasPostData: boolean;
	size?: number;
	failed?: string;
	time: number;
	finished: boolean;
};

export type LogEntry = {
	level: string;
	text: string;
	url?: string;
	time: number;
};

const MAX_REQUESTS = 1000;
const MAX_LOGS = 500;

const network = new Map<number, Map<string, NetEntry>>();
const consoles = new Map<number, LogEntry[]>();

function tabNetwork(tabId: number) {
	let entries = network.get(tabId);
	if (!entries) network.set(tabId, (entries = new Map()));
	return entries;
}

function pushLog(tabId: number, entry: LogEntry) {
	let entries = consoles.get(tabId);
	if (!entries) consoles.set(tabId, (entries = []));
	entries.push(entry);
	if (entries.length > MAX_LOGS) entries.shift();
}

function formatPreview(preview: any): string {
	const props = (preview.properties ?? []).map((prop: any) =>
		preview.subtype === "array"
			? prop.value
			: `${prop.name}: ${prop.value}`,
	);
	const inner = `${props.join(", ")}${preview.overflow ? ", …" : ""}`;
	return preview.subtype === "array" ? `[${inner}]` : `{${inner}}`;
}

function formatArg(arg: any): string {
	if (arg.value !== undefined)
		return typeof arg.value === "string"
			? arg.value
			: JSON.stringify(arg.value);
	if (
		arg.preview &&
		((arg.preview.type === "object" && !arg.preview.subtype) ||
			arg.preview.subtype === "array")
	)
		return formatPreview(arg.preview);
	return arg.description ?? arg.unserializableValue ?? arg.type;
}

bridge.on(({ tabId, method, params }) => {
	switch (method) {
		case "Network.requestWillBeSent": {
			const entries = tabNetwork(tabId);
			// Redirects reuse the requestId; re-insert so the newest hop sorts last.
			entries.delete(params.requestId);
			entries.set(params.requestId, {
				id: params.requestId,
				tabId,
				method: params.request.method,
				url: params.request.url,
				type: params.type,
				requestHeaders: params.request.headers ?? {},
				postData: params.request.postData,
				hasPostData: Boolean(params.request.hasPostData),
				time: Math.round((params.wallTime ?? Date.now() / 1000) * 1000),
				finished: false,
			});
			if (entries.size > MAX_REQUESTS)
				entries.delete(entries.keys().next().value!);
			return;
		}
		case "Network.responseReceived": {
			const entry = network.get(tabId)?.get(params.requestId);
			if (!entry) return;
			entry.status = params.response.status;
			entry.statusText = params.response.statusText;
			entry.mimeType = params.response.mimeType;
			entry.responseHeaders = params.response.headers;
			return;
		}
		case "Network.loadingFinished": {
			const entry = network.get(tabId)?.get(params.requestId);
			if (!entry) return;
			entry.finished = true;
			entry.size = params.encodedDataLength;
			return;
		}
		case "Network.loadingFailed": {
			const entry = network.get(tabId)?.get(params.requestId);
			if (!entry) return;
			entry.finished = true;
			entry.failed =
				params.errorText || (params.canceled ? "canceled" : "failed");
			return;
		}
		case "Runtime.consoleAPICalled":
			pushLog(tabId, {
				level: params.type,
				text: (params.args ?? []).map(formatArg).join(" "),
				url: params.stackTrace?.callFrames?.[0]?.url,
				time: Math.round(params.timestamp),
			});
			return;
		case "Runtime.exceptionThrown": {
			const details = params.exceptionDetails;
			pushLog(tabId, {
				level: "exception",
				text: details.exception?.description ?? details.text,
				url: details.url,
				time: Math.round(params.timestamp),
			});
			return;
		}
		case "Vitamine.tabClosed":
			network.delete(tabId);
			consoles.delete(tabId);
			return;
	}
});

export function requests(tabId: number) {
	return [...(network.get(tabId)?.values() ?? [])];
}

export function findRequest(id: string) {
	for (const entries of network.values()) {
		const entry = entries.get(id);
		if (entry) return entry;
	}
	return undefined;
}

export function clearRequests(tabId: number) {
	network.delete(tabId);
}

// Long-lived or background traffic that never "finishes" and shouldn't block network-idle waits.
const IGNORED_TYPES = new Set([
	"WebSocket",
	"EventSource",
	"Ping",
	"Media",
	"Manifest",
]);
const ANALYTICS =
	/google-analytics|googletagmanager|doubleclick|googlesyndication|facebook\.(com|net)\/tr|hotjar|segment\.(io|com)|sentry|datadoghq|clarity\.ms|mixpanel|amplitude|optimizely|newrelic|nr-data|bugsnag|criteo|taboola|outbrain|adservice|\/collect\b|\/beacon\b|\/log\b|\/track/i;

/** Requests still open that a page load would wait on: recent, not streaming, not analytics. */
export function pendingRequests(tabId: number) {
	const now = Date.now();
	return requests(tabId).filter(
		(entry) =>
			!entry.finished &&
			now - entry.time < 10_000 &&
			!IGNORED_TYPES.has(entry.type ?? "") &&
			!ANALYTICS.test(entry.url) &&
			!entry.url.startsWith("chrome-extension://"),
	);
}

export function consoleLogs(tabId: number) {
	return consoles.get(tabId) ?? [];
}

export function clearConsole(tabId: number) {
	consoles.delete(tabId);
}
