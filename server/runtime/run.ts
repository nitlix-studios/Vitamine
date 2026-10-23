import { bridge } from "../bridge";
import { listScripts, loadScript } from "../scripts";
import { createCookies, createLogs, createNet } from "./net";
import { newContext, Page, sleep, type RunContext } from "./page";

type ScriptFn = (...args: unknown[]) => Promise<unknown>;
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
	...args: string[]
) => ScriptFn;
const GLOBALS = [
	"page",
	"tabs",
	"net",
	"cookies",
	"logs",
	"scripts",
	"sleep",
	"log",
	"args",
] as const;

// A lone expression returns its value (REPL-style); otherwise the code needs an explicit `return`.
function compile(code: string) {
	try {
		return new AsyncFunction(
			...GLOBALS,
			`return (${code.trim().replace(/;+$/, "")}\n);`,
		);
	} catch {
		return new AsyncFunction(...GLOBALS, code);
	}
}

const format = (item: unknown) =>
	typeof item === "string" ? item : JSON.stringify(item);

async function activeTabId() {
	const tab = await bridge.call<{ id: number }>("tabs.active");
	return tab.id;
}

function environment(
	page: Page,
	ctx: RunContext,
	args: Record<string, unknown>,
) {
	const env: Record<(typeof GLOBALS)[number], unknown> = {
		page,
		tabs: {
			list: () => bridge.call("tabs.list"),
			active: async () => new Page(await activeTabId(), ctx),
			get: (id: number) => new Page(id, ctx),
			async open(
				url: string,
				{ active = false }: { active?: boolean } = {},
			) {
				// Debugger attach hangs on a fresh about:blank tab, so open the real URL directly.
				const tab = await bridge.call<{ id: number }>("tabs.create", {
					url,
					active,
				});
				const opened = new Page(tab.id, ctx);
				await opened.waitForLoad();
				ctx.trail.push(`opened tab ${tab.id}: ${url}`);
				return opened;
			},
			close: (id: number) => bridge.call("tabs.close", { tabId: id }),
			activate: (id: number) =>
				bridge.call("tabs.activate", { tabId: id }),
			detach: (id = page.tabId) => bridge.call("detach", { tabId: id }),
		},
		net: createNet(page),
		cookies: createCookies(page),
		logs: createLogs(page),
		scripts: {
			list: listScripts,
			async run(name: string, scriptArgs: Record<string, unknown> = {}) {
				const fn = compile(await loadScript(name));
				return fn(
					...GLOBALS.map((global) =>
						global === "args" ? scriptArgs : env[global],
					),
				);
			},
		},
		sleep,
		log: (...items: unknown[]) =>
			ctx.logs.push(items.map(format).join(" ")),
		args,
	};
	return env;
}

export type RunInput = {
	code: string;
	tabId?: number;
	args?: Record<string, unknown>;
	timeoutMs?: number;
};
export type RunOutput = RunContext & { changes: string[] } & (
		| { ok: true; result: unknown }
		| { ok: false; error: string }
	);

type TabInfo = {
	id: number;
	url: string;
	openerTabId?: number;
	agent: boolean;
};

const listTabs = () =>
	bridge.call<TabInfo[]>("tabs.list").catch(() => [] as TabInfo[]);

// What a run did to the browser that its return value might not mention: new tabs, closed tabs, URL changes.
function describeChanges(
	before: TabInfo[],
	after: TabInfo[],
	touched: Set<number>,
) {
	const was = new Map(before.map((tab) => [tab.id, tab]));
	const now = new Map(after.map((tab) => [tab.id, tab]));
	const changes: string[] = [];
	for (const tab of after) {
		const old = was.get(tab.id);
		if (
			!old &&
			(touched.has(tab.openerTabId ?? -1) ||
				(tab.agent && tab.openerTabId !== undefined))
		) {
			changes.push(
				`+ tab ${tab.id} opened by tab ${tab.openerTabId} (kept in background): ${tab.url.slice(0, 120)}`,
			);
		} else if (!old && tab.agent) {
			changes.push(`+ tab ${tab.id} opened: ${tab.url.slice(0, 120)}`);
		} else if (old && touched.has(tab.id) && old.url !== tab.url) {
			changes.push(
				`~ tab ${tab.id}: ${old.url.slice(0, 80)} → ${tab.url.slice(0, 120)}`,
			);
		}
	}
	for (const tab of before) {
		if (!now.has(tab.id) && (touched.has(tab.id) || tab.agent))
			changes.push(`- tab ${tab.id} closed`);
	}
	return changes;
}

export default async function ({
	code,
	tabId,
	args = {},
	timeoutMs = 60_000,
}: RunInput): Promise<RunOutput> {
	const ctx = newContext();
	const fn = compile(code);
	const page = new Page(tabId ?? (await activeTabId()), ctx);
	const env = environment(page, ctx, args);
	const before = await listTabs();
	const finish = async () =>
		describeChanges(before, await listTabs(), ctx.touched);

	let timer: Timer | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() => reject(new Error(`Script timed out after ${timeoutMs}ms`)),
			timeoutMs,
		);
	});

	try {
		const result = await Promise.race([
			fn(...GLOBALS.map((global) => env[global])),
			timeout,
		]);
		return { ok: true, result, ...ctx, changes: await finish() };
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
			...ctx,
			changes: await finish(),
		};
	} finally {
		clearTimeout(timer);
	}
}
