import { bridge } from "../bridge";
import {
	clearConsole,
	clearRequests,
	consoleLogs,
	findRequest,
	requests,
	type NetEntry,
} from "../store";
import { Page, parseJson, type Matcher } from "./page";

// Values of these headers never reach tool output unless the script asks with reveal:true.
const SECRET_HEADERS =
	/^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|x-csrf-token|x-xsrf-token)$/i;
// The browser sets these itself; fetch() rejects or ignores them.
const FORBIDDEN_HEADERS =
	/^(cookie|host|origin|referer|content-length|connection|accept-encoding|user-agent|sec-.*|:.*)$/i;
const TEXT_MIME =
	/^(text\/|application\/(json|javascript|xml|x-www-form-urlencoded)|.*\+json|.*\+xml)/i;

const hidden = (value: string) => `«hidden, ${value.length} chars»`;

function redact(headers: Record<string, string> | undefined, reveal: boolean) {
	if (!headers || reveal) return headers;
	return Object.fromEntries(
		Object.entries(headers).map(([key, value]) => [
			key,
			SECRET_HEADERS.test(key) ? hidden(value) : value,
		]),
	);
}

const textTest = (match?: Matcher) =>
	match instanceof RegExp
		? (s: string) => match.test(s)
		: match
			? (s: string) => s.includes(match)
			: () => true;

const summary = (e: NetEntry) => ({
	id: e.id,
	method: e.method,
	status: e.status,
	type: e.type,
	url: e.url,
	...(e.failed ? { failed: e.failed } : {}),
	...(e.finished ? {} : { pending: true }),
});

type ListFilter = {
	url?: Matcher;
	method?: string;
	status?: number;
	type?: string;
	failed?: boolean;
	limit?: number;
	tabId?: number;
	/** Include traffic from other extensions' content scripts (hidden by default). */
	extensions?: boolean;
};

const fromExtension = (url?: string) =>
	Boolean(url?.startsWith("chrome-extension://"));

export function createNet(page: Page) {
	const entry = (id: string) => {
		const found = findRequest(id);
		if (!found) throw new Error(`No captured request "${id}"`);
		return found;
	};

	const postData = async (id: string) => {
		const e = entry(id);
		if (e.postData !== undefined || !e.hasPostData) return e.postData;
		const { postData } = await bridge.cdp(
			e.tabId,
			"Network.getRequestPostData",
			{ requestId: id },
		);
		return postData as string;
	};

	return {
		list({
			url,
			method,
			status,
			type,
			failed,
			limit = 50,
			tabId = page.tabId,
			extensions = false,
		}: ListFilter = {}) {
			const test = textTest(url);
			return requests(tabId)
				.filter(
					(e) =>
						(extensions || !fromExtension(e.url)) &&
						test(e.url) &&
						(!method || e.method === method.toUpperCase()) &&
						(status === undefined || e.status === status) &&
						(!type ||
							e.type?.toLowerCase() === type.toLowerCase()) &&
						(failed === undefined || Boolean(e.failed) === failed),
				)
				.slice(-limit)
				.map(summary);
		},

		get(id: string, { reveal = false }: { reveal?: boolean } = {}) {
			const e = entry(id);
			return {
				...e,
				requestHeaders: redact(e.requestHeaders, reveal),
				responseHeaders: redact(e.responseHeaders, reveal),
			};
		},

		async body(id: string) {
			const e = entry(id);
			const res = await bridge.cdp(e.tabId, "Network.getResponseBody", {
				requestId: id,
			});
			if (res.base64Encoded && !TEXT_MIME.test(e.mimeType ?? ""))
				return { base64: res.body as string, mimeType: e.mimeType };
			const text: string = res.base64Encoded
				? Buffer.from(res.body, "base64").toString("utf8")
				: res.body;
			return { text, json: parseJson(text) };
		},

		postData,

		/** Re-send a captured request from its page, optionally changed. */
		async replay(
			id: string,
			overrides: {
				url?: string;
				method?: string;
				headers?: Record<string, string>;
				body?: unknown;
			} = {},
		) {
			const e = entry(id);
			const method = overrides.method ?? e.method;
			const headers = Object.fromEntries(
				Object.entries({
					...e.requestHeaders,
					...overrides.headers,
				}).filter(([key]) => !FORBIDDEN_HEADERS.test(key)),
			);
			const body = ["GET", "HEAD"].includes(method.toUpperCase())
				? undefined
				: (overrides.body ?? (await postData(id)));
			return new Page(e.tabId, page.ctx).fetch(overrides.url ?? e.url, {
				method,
				headers,
				body,
			});
		},

		fetch: (url: string, init?: Parameters<Page["fetch"]>[1]) =>
			page.fetch(url, init),

		/** Start capturing on this tab now; reload:true also catches the page-load requests. */
		async capture({ reload = false }: { reload?: boolean } = {}) {
			await page.attach();
			if (reload) await page.reload();
			return requests(page.tabId).length;
		},

		clear(tabId = page.tabId) {
			clearRequests(tabId);
		},
	};
}

type CookieQuery = {
	url?: string;
	domain?: string;
	name?: string;
	reveal?: boolean;
};

export function createCookies(page: Page) {
	return {
		/** Includes HttpOnly cookies. Defaults to the cookies sent to the page's current URL. */
		async get({ url, domain, name, reveal = false }: CookieQuery = {}) {
			// chrome.cookies works whether or not the debugger can attach to the tab.
			const cookies = await bridge.call<any[]>(
				"cookies",
				domain
					? { domain: domain.replace(/^\./, "") }
					: { url: url ?? (await page.info()).url },
			);
			return cookies
				.filter((c) => !name || c.name === name)
				.map((c) => ({
					name: c.name,
					value: reveal ? c.value : hidden(c.value),
					domain: c.domain,
					path: c.path,
					httpOnly: c.httpOnly,
					secure: c.secure,
					sameSite: c.sameSite,
					expires: c.session
						? "session"
						: new Date(c.expirationDate * 1000).toISOString(),
				}));
		},
	};
}

export function createLogs(page: Page) {
	return {
		list({
			level,
			pattern,
			limit = 100,
			tabId = page.tabId,
			extensions = false,
		}: {
			level?: string;
			pattern?: Matcher;
			limit?: number;
			tabId?: number;
			extensions?: boolean;
		} = {}) {
			const test = textTest(pattern);
			return consoleLogs(tabId)
				.filter(
					(entry) =>
						(extensions || !fromExtension(entry.url)) &&
						(!level || entry.level === level) &&
						test(entry.text),
				)
				.slice(-limit);
		},

		clear(tabId = page.tabId) {
			clearConsole(tabId);
		},
	};
}
