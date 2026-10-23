import { BlockedError, bridge } from "../bridge";
import { pendingRequests } from "../store";

// Imported as text (not read from disk) so `bun --watch` restarts the server when it changes.
import INJECT_SOURCE from "./inject.js" with { type: "text" };
// Pages keep the helper between calls; a content hash makes them pick up edits.
const INJECT = INJECT_SOURCE.replace(
	"__LIXB_VERSION__",
	Bun.hash(INJECT_SOURCE).toString(36),
);

export type Matcher = string | RegExp;
export type SpecObject = {
	text?: Matcher;
	exact?: boolean;
	role?: string;
	selector?: string;
	near?: Spec;
	direction?: "left" | "right" | "above" | "below";
	within?: Spec;
	nth?: number;
	hidden?: boolean;
	ref?: string;
};
export type Spec = Matcher | El | SpecObject;

type Rect = { x: number; y: number; w: number; h: number };
type Descriptor = {
	ref: string;
	role: string;
	name: string;
	tag: string;
	rect: Rect;
};
type PageInfo = {
	url: string;
	title: string;
	readyState: string;
	viewport: { w: number; h: number; dpr: number };
	scroll: { x: number; y: number; height: number };
};
type LoadOptions = { until?: "load" | "dom" | "none"; timeout?: number };
type ClickOptions = {
	force?: boolean;
	button?: "left" | "right" | "middle";
	clickCount?: number;
	timeout?: number;
};

export type RunContext = {
	images: { data: string; mimeType: string }[];
	logs: string[];
	/** Actions done so far, shown when a script fails so the caller knows how far it got. */
	trail: string[];
	/** Warnings worth showing even on success (ambiguous clicks, fallback mode). */
	notes: string[];
	/** Tabs this run touched, for the end-of-run summary of tab and URL changes. */
	touched: Set<number>;
};

export const newContext = (): RunContext => ({
	images: [],
	logs: [],
	trail: [],
	notes: [],
	touched: new Set(),
});

// Last snapshot lines per tab, so snapshot({diff:true}) can return only what changed.
const lastSnapshots = new Map<number, Set<string>>();

// Tabs the debugger was refused on, and when; they use the in-page fallback for a while, then retry.
const FALLBACK_RETRY_MS = 60_000;
const fallbackSince = new Map<number, number>();

export const sleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function poll<T>(
	check: () => Promise<T | null | undefined | false>,
	timeout: number,
	interval = 150,
) {
	const deadline = Date.now() + timeout;
	for (;;) {
		const value = await check();
		if (value) return value;
		if (Date.now() >= deadline) return null;
		await sleep(interval);
	}
}

export function parseJson(text: string) {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function wire(spec: Spec): Record<string, unknown> {
	if (spec instanceof El) return { ref: spec.ref };
	if (spec instanceof RegExp)
		return { text: { re: spec.source, flags: spec.flags } };
	if (typeof spec === "string") return { text: spec };

	const out: Record<string, unknown> = { ...spec };
	if (spec.text instanceof RegExp)
		out.text = { re: spec.text.source, flags: spec.text.flags };
	if (spec.near) out.near = wire(spec.near);
	if (spec.within) out.within = wire(spec.within);
	return out;
}

function asObject(spec: Spec): SpecObject {
	if (spec instanceof El)
		throw new Error(
			"Pass a text, RegExp or spec object here, not an element",
		);
	if (typeof spec === "string" || spec instanceof RegExp)
		return { text: spec };
	return spec;
}

const label = (spec: Spec) =>
	spec instanceof El ? spec.label : JSON.stringify(wire(spec));
const quote = (text: string, max = 40) =>
	JSON.stringify(text.length > max ? `${text.slice(0, max)}…` : text);

const BUTTONS = { left: 1, right: 2, middle: 4 };
const MODIFIERS: Record<string, number> = {
	alt: 1,
	option: 1,
	ctrl: 2,
	control: 2,
	meta: 4,
	cmd: 4,
	command: 4,
	shift: 8,
};
const KEYS: Record<
	string,
	[key: string, code: string, keyCode: number, text?: string]
> = {
	enter: ["Enter", "Enter", 13, "\r"],
	tab: ["Tab", "Tab", 9],
	escape: ["Escape", "Escape", 27],
	esc: ["Escape", "Escape", 27],
	backspace: ["Backspace", "Backspace", 8],
	delete: ["Delete", "Delete", 46],
	space: [" ", "Space", 32, " "],
	arrowup: ["ArrowUp", "ArrowUp", 38],
	arrowdown: ["ArrowDown", "ArrowDown", 40],
	arrowleft: ["ArrowLeft", "ArrowLeft", 37],
	arrowright: ["ArrowRight", "ArrowRight", 39],
	home: ["Home", "Home", 36],
	end: ["End", "End", 35],
	pageup: ["PageUp", "PageUp", 33],
	pagedown: ["PageDown", "PageDown", 34],
};
// With ctrl/cmd held, Chrome only performs editing shortcuts when told which command to run.
const EDIT_COMMANDS: Record<string, string> = {
	a: "selectAll",
	c: "copy",
	x: "cut",
	v: "paste",
	z: "undo",
};

export class El {
	readonly ref: string;
	readonly role: string;
	readonly name: string;
	readonly tag: string;
	readonly rect: Rect;

	constructor(
		readonly page: Page,
		d: Descriptor,
	) {
		this.ref = d.ref;
		this.role = d.role;
		this.name = d.name;
		this.tag = d.tag;
		this.rect = d.rect;
	}

	click(opts?: ClickOptions) {
		return this.page.click(this, opts);
	}
	dblclick() {
		return this.page.dblclick(this);
	}
	hover() {
		return this.page.hover(this);
	}
	fill(text: string) {
		return this.page.fill(this, text);
	}
	select(value: string) {
		return this.page.select(this, value);
	}
	check(on = true) {
		return this.page.check(this, on);
	}
	scroll() {
		return this.page.scroll(this);
	}
	screenshot() {
		return this.page.screenshot({ of: this });
	}
	find(spec: Spec) {
		return this.page.find({ ...asObject(spec), within: this });
	}
	findAll(spec: Spec, opts?: { limit?: number }) {
		return this.page.findAll({ ...asObject(spec), within: this }, opts);
	}
	near(spec: Spec, direction?: SpecObject["direction"]) {
		return this.page.find({ ...asObject(spec), near: this, direction });
	}
	text() {
		return this.page.call<string>("text", this.ref);
	}
	attr(name: string) {
		return this.page.call<string | null>("attr", this.ref, name);
	}
	value() {
		return this.page.call<string>("value", this.ref);
	}
	read(max?: number) {
		return this.page.read({ of: this, max });
	}

	get label() {
		return this.role
			? `${this.ref} ${this.role} ${quote(this.name, 60)}`
			: this.ref;
	}

	toJSON() {
		return {
			ref: this.ref,
			role: this.role,
			name: this.name,
			rect: this.rect,
		};
	}
}

export class Page {
	constructor(
		readonly tabId: number,
		readonly ctx: RunContext,
	) {}

	/** Same as tabId; matches the `id` field of tabs.list() entries. */
	get id() {
		return this.tabId;
	}

	toJSON() {
		return { tabId: this.tabId };
	}

	cdp<T = any>(
		method: string,
		params: Record<string, unknown> = {},
		timeoutMs?: number,
	) {
		this.ctx.touched.add(this.tabId);
		return bridge.cdp<T>(this.tabId, method, params, timeoutMs);
	}

	attach() {
		return this.cdp("Runtime.evaluate", { expression: "1" });
	}

	/** "cdp": real input through the debugger. "dom": in-page fallback with synthetic events. */
	get mode(): "cdp" | "dom" {
		const since = fallbackSince.get(this.tabId);
		return since !== undefined && Date.now() - since < FALLBACK_RETRY_MS
			? "dom"
			: "cdp";
	}

	set mode(mode: "cdp" | "dom") {
		if (mode === "dom") fallbackSince.set(this.tabId, Date.now());
		else fallbackSince.delete(this.tabId);
	}

	private async via<T>(
		cdp: () => Promise<T>,
		dom: () => Promise<T>,
	): Promise<T> {
		this.ctx.touched.add(this.tabId);
		if (this.mode === "dom") return dom();
		try {
			return await cdp();
		} catch (error) {
			if (!(error instanceof BlockedError)) throw error;
			fallbackSince.set(this.tabId, Date.now());
			this.ctx.notes.push(
				`tab ${this.tabId}: debugger blocked by another extension's frame, switched to fallback mode (synthetic input; no network/console capture)`,
			);
			return dom();
		}
	}

	private evaluate<T>(
		expression: string,
		{ prelude = "", replMode = false } = {},
	): Promise<T> {
		return this.via(
			async () => {
				const res = await this.cdp("Runtime.evaluate", {
					expression: prelude
						? `${prelude}\n;${expression}`
						: expression,
					returnByValue: true,
					awaitPromise: true,
					userGesture: true,
					replMode,
				});
				if (res.exceptionDetails) {
					const description: string =
						res.exceptionDetails.exception?.description ??
						res.exceptionDetails.text;
					throw new Error(description.split("\n")[0]);
				}
				return res.result.value as T;
			},
			async () => {
				// No REPL mode here: string code must be a single expression.
				const code = `(async () => { ${prelude}\n; return await (${expression}\n); })().then((value) => ({ ok: true, value }), (error) => ({ ok: false, error: String(error?.message ?? error) }))`;
				const res = await bridge.call<{
					ok: boolean;
					value?: T;
					error?: string;
				}>("eval", { tabId: this.tabId, code });
				if (!res.ok) throw new Error(res.error);
				return res.value as T;
			},
		);
	}

	/** Run a function (or expression string) inside the page. */
	eval<T = unknown>(
		fn: string | ((...args: any[]) => unknown),
		...args: unknown[]
	) {
		if (typeof fn === "string")
			return this.evaluate<T>(fn, { replMode: true });
		return this.evaluate<T>(
			`(${fn.toString()})(...${JSON.stringify(args)})`,
		);
	}

	call<T>(method: string, ...args: unknown[]) {
		return this.evaluate<T>(
			`window.__lixb.${method}(...${JSON.stringify(args)})`,
			{ prelude: INJECT },
		);
	}

	// ── navigation ──

	async goto(url: string, opts: LoadOptions = {}) {
		await this.via(
			async () => {
				const res = await this.cdp("Page.navigate", { url });
				if (res.errorText)
					throw new Error(
						`Navigation to ${url} failed: ${res.errorText}`,
					);
			},
			() => bridge.call("tabs.navigate", { tabId: this.tabId, url }),
		);
		await this.waitForLoad(opts);
		this.ctx.trail.push(`goto ${url}`);
		return this.info();
	}

	async reload(opts: LoadOptions = {}) {
		await this.via(
			() => this.cdp("Page.reload", {}),
			() => bridge.call("tabs.reload", { tabId: this.tabId }),
		);
		await this.waitForLoad(opts);
		return this.info();
	}

	back(opts: LoadOptions = {}) {
		return this.history(-1, opts);
	}

	forward(opts: LoadOptions = {}) {
		return this.history(1, opts);
	}

	private async history(delta: number, opts: LoadOptions) {
		await this.via(
			async () => {
				const { currentIndex, entries } = await this.cdp(
					"Page.getNavigationHistory",
				);
				const entry = entries[currentIndex + delta];
				if (!entry)
					throw new Error(
						delta < 0
							? "No page to go back to"
							: "No page to go forward to",
					);
				await this.cdp("Page.navigateToHistoryEntry", {
					entryId: entry.id,
				});
			},
			() =>
				bridge.call(delta < 0 ? "tabs.back" : "tabs.forward", {
					tabId: this.tabId,
				}),
		);
		await this.waitForLoad(opts);
		return this.info();
	}

	async waitForLoad({ until = "load", timeout = 30_000 }: LoadOptions = {}) {
		if (until === "none") return;
		await sleep(100);
		const done = await poll(async () => {
			// In fallback mode the old document can still answer right after navigating; ask the tab too.
			if (
				this.mode === "dom" &&
				(
					await bridge.call<{ status: string }>("tabs.get", {
						tabId: this.tabId,
					})
				).status !== "complete"
			)
				return false;
			const [state, url] = await this.evaluate<[string, string]>(
				"[document.readyState, location.href]",
			).catch(() => ["loading", ""]);
			// A new tab reports a "complete" about:blank before its real page commits.
			if (url === "about:blank") return false;
			return (
				state === "complete" ||
				(until === "dom" && state === "interactive")
			);
		}, timeout);
		if (!done)
			throw new Error(`Page did not finish loading within ${timeout}ms`);
	}

	// ── reading ──

	info() {
		return this.call<PageInfo>("info");
	}

	/** Visible interactive elements as text lines, each with a ref usable via page.ref(). */
	async snapshot({
		all = false,
		limit = 150,
		within,
		diff = false,
		grep,
	}: {
		all?: boolean;
		limit?: number;
		within?: Spec;
		diff?: boolean;
		grep?: Matcher;
	} = {}) {
		const scope = within ? (await this.resolve(within)).ref : null;
		const text = await this.call<string>("snapshot", {
			all: all || Boolean(grep),
			limit: grep ? 2_000 : limit,
			within: scope,
		});
		const [title, viewport, ...allLines] = text.split("\n");
		const test =
			grep instanceof RegExp
				? (line: string) => grep.test(line)
				: (line: string) =>
						line.toLowerCase().includes(String(grep).toLowerCase());
		const lines = grep ? allLines.filter(test).slice(0, limit) : allLines;
		if (grep)
			return `${title}\n${lines.join("\n") || "(no matching elements)"}`;
		const header = `${title}\n${viewport}`;
		const previous = lastSnapshots.get(this.tabId);
		lastSnapshots.set(this.tabId, new Set(lines));
		if (!diff || !previous) return text;

		const added = lines.filter((line) => !previous.has(line));
		const removed = [...previous].filter(
			(line) => !lines.includes(line),
		).length;
		return `${header}\n${added.length ? added.map((line) => `+ ${line}`).join("\n") : "(no new elements)"}\n${removed} element lines gone since the last snapshot`;
	}

	/** innerText of every element matching spec (cards, rows, results), as [{ref, text}]. */
	async readAll(
		spec: Spec,
		{
			limit = 50,
			max = 500,
			where,
		}: { limit?: number; max?: number; where?: Matcher } = {},
	) {
		const filter =
			where instanceof RegExp
				? { re: where.source, flags: where.flags }
				: (where ?? null);
		return this.call<{ ref: string; text: string }[]>(
			"readAll",
			wire(spec),
			limit,
			max,
			filter,
		);
	}

	/**
	 * Close cookie banners, sign-in nags and similar overlays the way a privacy-minded person would:
	 * "Reject"/"Only necessary" first, then close/dismiss buttons. Returns what it clicked.
	 */
	async dismiss({ rounds = 3 }: { rounds?: number } = {}) {
		const order: SpecObject[] = [
			{
				role: "button",
				text: /^(reject( all)?( cookies)?|decline( all)?|refuse( all)?|(use )?(only )?(strictly )?necessary( cookies)?( only)?|deny)$/i,
			},
			{
				role: "button",
				text: /^(close|dismiss|no,? thanks|not now|maybe later|skip|×|✕|x)$/i,
			},
			{
				role: "button",
				text: /^(close|dismiss)\b.*(dialog|banner|sign.?in|popup|modal|message)?/i,
			},
		];
		const clicked: string[] = [];
		for (let round = 0; round < rounds; round++) {
			let hit: El | null = null;
			for (const spec of order) {
				hit = await this.find(spec).catch(() => null);
				if (hit) break;
			}
			if (!hit) break;
			await this.click(hit, { timeout: 1_000 }).catch(() => null);
			clicked.push(hit.label);
		}
		this.ctx.trail.push(
			clicked.length
				? `dismissed: ${clicked.join("; ")}`
				: "dismiss: no overlays found",
		);
		return clicked;
	}

	/** Page or element text. around: text/RegExp returns just the context around each occurrence (max chars each). */
	async read({
		of,
		max,
		around,
	}: { of?: Spec; max?: number; around?: Matcher } = {}) {
		const ref = of ? (await this.resolve(of)).ref : null;
		const pattern =
			around instanceof RegExp
				? { re: around.source, flags: around.flags }
				: around;
		return this.call<string>(
			"read",
			ref,
			max ?? (around ? 400 : 20_000),
			pattern ?? null,
		);
	}

	async find(spec: Spec) {
		const [el] = await this.findAll(spec, { limit: 1 });
		return el ?? null;
	}

	async findAll(spec: Spec, { limit = 20 }: { limit?: number } = {}) {
		return (await this.locate(spec, limit)).items;
	}

	private async locate(spec: Spec, limit: number) {
		const { items, total } = await this.call<{
			items: Descriptor[];
			total: number;
		}>("find", wire(spec), { limit });
		return { items: items.map((d) => new El(this, d)), total };
	}

	async count(spec: Spec) {
		const { total } = await this.call<{ total: number }>(
			"find",
			wire(spec),
			{ limit: 0 },
		);
		return total;
	}

	/** An element from a snapshot line, e.g. page.ref('e12').click(). Not async. */
	ref(ref: string) {
		return new El(this, {
			ref,
			role: "",
			name: "",
			tag: "",
			rect: { x: 0, y: 0, w: 0, h: 0 },
		});
	}

	// Actions wait for their target to show up, like a person waiting for the page.
	private async resolve(target: Spec, timeout = 5_000) {
		return (await this.resolveCounted(target, timeout)).el;
	}

	private async resolveCounted(
		target: Spec,
		timeout = 5_000,
	): Promise<{ el: El; total: number }> {
		if (target instanceof El) return { el: target, total: 1 };
		let lastError: unknown;
		const found = await poll(async () => {
			try {
				const { items, total } = await this.locate(target, 1);
				return items[0] ? { el: items[0], total } : null;
			} catch (error) {
				lastError = error;
				return null;
			}
		}, timeout);
		if (found) return found;

		const reason =
			lastError instanceof Error ? ` (${lastError.message})` : "";
		const close = await this.call<string[]>("suggest", wire(target)).catch(
			() => [],
		);
		const hint = close.length
			? `\nClosest on the page:\n  ${close.join("\n  ")}`
			: "";
		throw new Error(
			`Nothing matches ${label(target)} after ${timeout}ms${reason}${hint}`,
		);
	}

	/** Wait until the DOM stops changing (or navigation finishes) after an action. */
	async settle({
		quiet = 200,
		max = 3_000,
	}: { quiet?: number; max?: number } = {}) {
		const deadline = Date.now() + max;
		let last = "";
		let stableSince = Date.now();
		while (Date.now() < deadline) {
			const state = await this.call<[number, string, string]>(
				"mutations",
			).catch(() => null);
			if (!state) {
				// Mid-navigation: wait for the next document instead.
				await this.waitForLoad({
					until: "dom",
					timeout: Math.max(1_000, deadline - Date.now()),
				}).catch(() => {});
				return;
			}
			const key = state.join("|");
			if (state[2] === "loading") {
				last = "";
			} else if (key !== last) {
				last = key;
				stableSince = Date.now();
			} else if (Date.now() - stableSince >= quiet) return;
			await sleep(50);
		}
	}

	// ── acting ──

	private mouse(
		x: number,
		y: number,
		button: keyof typeof BUTTONS = "left",
		clickCount = 1,
		hidden = false,
	) {
		return this.via(
			async () => {
				// A hidden tab stalls ~5s on its first input event waiting for a frame; render one first.
				if (hidden) {
					await this.emulateFocus();
					await this.cdp("Page.captureScreenshot", {
						format: "jpeg",
						quality: 1,
						clip: { x: 0, y: 0, width: 1, height: 1, scale: 1 },
						captureBeyondViewport: true,
					});
				}
				await this.cdp("Input.dispatchMouseEvent", {
					type: "mouseMoved",
					x,
					y,
				});
				for (let count = 1; count <= clickCount; count++) {
					const event = {
						x,
						y,
						button,
						buttons: BUTTONS[button],
						clickCount: count,
					};
					await this.cdp("Input.dispatchMouseEvent", {
						type: "mousePressed",
						...event,
					});
					await this.cdp("Input.dispatchMouseEvent", {
						type: "mouseReleased",
						...event,
						buttons: 0,
					});
				}
			},
			async () => {
				await this.call("synthClick", x, y, button, clickCount);
			},
		);
	}

	private insertText(text: string) {
		return this.via(
			() => this.cdp("Input.insertText", { text }),
			() => this.call("insertText", text),
		);
	}

	/** Clicks, then waits for the page to settle. Returns the clicked El (with .matches and .navigated). */
	async click(
		target: Spec,
		{
			force = false,
			button = "left",
			clickCount = 1,
			timeout,
			settle = true,
		}: ClickOptions & { settle?: boolean } = {},
	) {
		const { el, total } = await this.resolveCounted(target, timeout);
		const point = await this.call<{
			x: number;
			y: number;
			covered: boolean;
			by: string | null;
			url: string;
			hidden: boolean;
		}>("point", el.ref);
		if (point.covered && !force) {
			throw new Error(
				`${el.label} is covered by ${point.by ?? "another element"}; close the overlay or pass {force:true}`,
			);
		}
		// Tabs the page opens in response (target=_blank, window.open) come back as `opened`.
		const opened: Page[] = [];
		const stop = bridge.on((event) => {
			if (
				event.method === "Vitamine.tabOpened" &&
				event.params.openerTabId === this.tabId
			)
				opened.push(new Page(event.tabId, this.ctx));
		});
		try {
			await this.mouse(
				point.x,
				point.y,
				button,
				clickCount,
				point.hidden,
			);
			if (settle) await this.settle();
			else await sleep(100);
		} finally {
			stop();
		}

		const url = await this.evaluate<string>("location.href").catch(
			() => point.url,
		);
		const navigated = url !== point.url ? url : undefined;
		const step = [
			`click ${el.label}`,
			total > 1 ? ` (first of ${total} matches)` : "",
			navigated ? ` → navigated to ${navigated}` : "",
			opened.length
				? ` → opened tab ${opened.map((p) => p.tabId).join(", ")} in the background`
				: "",
		].join("");
		this.ctx.trail.push(step);
		if (total > 1)
			this.ctx.notes.push(
				`${step}. If that was the wrong one, narrow it with near/within/exact or nth.`,
			);
		return Object.assign(el, { matches: total, navigated, opened });
	}

	dblclick(target: Spec) {
		return this.click(target, { clickCount: 2 });
	}

	async hover(target: Spec) {
		const el = await this.resolve(target);
		const { x, y } = await this.call<{ x: number; y: number }>(
			"point",
			el.ref,
		);
		await this.via(
			() =>
				this.cdp("Input.dispatchMouseEvent", {
					type: "mouseMoved",
					x,
					y,
				}),
			() => this.call("synthHover", x, y),
		);
		return el;
	}

	/** Focus the field at/labelled by/next to target, replace its contents with text. */
	async fill(target: Spec, text: string) {
		const el = await this.resolve(target);
		await this.emulateFocus();
		const field = await this.call<Descriptor>("focusEditable", el.ref);
		if (field.tag === "select") {
			await this.call("selectOption", field.ref, text);
			return new El(this, field);
		}

		// Inserted text is dropped until the page has had a real pointer event, so click the
		// field like a person would, then re-select its contents (the click collapses the selection).
		const point = await this.call<{
			x: number;
			y: number;
			covered: boolean;
			hidden: boolean;
		}>("point", field.ref);
		if (!point.covered) {
			await this.mouse(point.x, point.y, "left", 1, point.hidden);
			await this.call("focusEditable", field.ref);
		}

		if (text) await this.insertText(text);
		else await this.press("Backspace");
		const filled = new El(this, field);
		this.ctx.trail.push(`fill ${filled.label} ← ${quote(text)}`);
		return filled;
	}

	/**
	 * Autocomplete: type text into a field, wait for a suggestion matching option (default: text)
	 * to appear near it, click it. Returns the clicked suggestion.
	 */
	async pick(
		field: Spec,
		text: string,
		option: Matcher = text,
		{ timeout = 8_000 }: { timeout?: number } = {},
	) {
		const before = new Set(
			(await this.findAll({ text: option }, { limit: 100 })).map(
				(el) => el.ref,
			),
		);
		const input = await this.fill(field, text);
		const choice = await poll(async () => {
			const candidates = await this.findAll(
				{ text: option, near: input },
				{ limit: 20 },
			).catch(() => []);
			return (
				candidates.find(
					(el) => el.ref !== input.ref && !before.has(el.ref),
				) ?? null
			);
		}, timeout);
		if (!choice) {
			throw new Error(
				`No suggestion matching ${typeof option === "string" ? quote(option) : option} appeared near ${input.label} within ${timeout}ms`,
			);
		}
		return this.click(choice);
	}

	// Background tabs never get real focus, so typed text would go nowhere without this.
	private emulateFocus() {
		return this.via(
			() =>
				this.cdp("Emulation.setFocusEmulationEnabled", {
					enabled: true,
				}),
			async () => {},
		);
	}

	/** Type into whatever has focus. keys:true sends real key events per character. */
	async type(text: string, { keys = false }: { keys?: boolean } = {}) {
		await this.emulateFocus();
		if (!keys) {
			await this.insertText(text);
			return;
		}
		for (const char of text)
			await this.press(char === "\n" ? "Enter" : char);
	}

	/** 'Enter', 'Escape', 'cmd+a', 'shift+Tab', 'a' … */
	async press(combo: string) {
		const parts = combo.length > 1 ? combo.split("+") : [combo];
		const name = parts.pop()!;
		let modifiers = 0;
		for (const part of parts) {
			const bit = MODIFIERS[part.toLowerCase()];
			if (!bit)
				throw new Error(`Unknown modifier "${part}" in "${combo}"`);
			modifiers |= bit;
		}

		let key: string,
			code: string,
			keyCode: number,
			text: string | undefined;
		const named = KEYS[name.toLowerCase()];
		if (named) [key, code, keyCode, text] = named;
		else if (name.length === 1) {
			key = name;
			text = name;
			keyCode = name.toUpperCase().charCodeAt(0);
			code = /[a-z]/i.test(name)
				? `Key${name.toUpperCase()}`
				: /\d/.test(name)
					? `Digit${name}`
					: "";
		} else throw new Error(`Unknown key "${name}"`);

		const shortcut = (modifiers & (MODIFIERS.ctrl | MODIFIERS.meta)) !== 0;
		const command = shortcut ? EDIT_COMMANDS[key.toLowerCase()] : undefined;
		const base = { key, code, windowsVirtualKeyCode: keyCode, modifiers };
		await this.via(
			async () => {
				await this.cdp("Input.dispatchKeyEvent", {
					...base,
					type: text && !shortcut ? "keyDown" : "rawKeyDown",
					text: shortcut ? undefined : text,
					commands: command ? [command] : undefined,
				});
				await this.cdp("Input.dispatchKeyEvent", {
					...base,
					type: "keyUp",
				});
			},
			async () => {
				await this.call(
					"synthKey",
					key,
					code,
					keyCode,
					modifiers,
					command ?? null,
				);
			},
		);
		if (key === "Enter") {
			this.ctx.trail.push(`press ${combo}`);
			await this.settle();
		}
	}

	async select(target: Spec, value: string) {
		const el = await this.resolve(target);
		return this.call<string>("selectOption", el.ref, value);
	}

	async check(target: Spec, on = true) {
		const el = await this.resolve(target);
		if ((await this.call<boolean>("checked", el.ref)) !== on)
			await this.click(el);
		return el;
	}

	/** scroll({y: 800}) scrolls the container under the viewport centre (or `in`); scroll(spec) brings an element into view. */
	async scroll(
		target: Spec | { x?: number; y?: number; in?: Spec } = { y: 600 },
	) {
		const isDelta =
			typeof target === "object" &&
			!(target instanceof El) &&
			!(target instanceof RegExp) &&
			("x" in target || "y" in target);
		if (isDelta) {
			// Wheel events hang in background tabs (no frames are rendered), so scroll from inside the page.
			const delta = target as { x?: number; y?: number; in?: Spec };
			const ref = delta.in ? (await this.resolve(delta.in)).ref : null;
			return this.call<{
				container: string;
				x: number;
				y: number;
				height: number;
			}>("scrollBy", delta.x ?? 0, delta.y ?? 0, ref);
		}

		const el = await this.resolve(target as Spec);
		await this.call("scrollTo", el.ref);
		return el;
	}

	// ── waiting ──

	async waitFor(
		spec: Spec,
		{
			timeout = 10_000,
			gone = false,
		}: { timeout?: number; gone?: boolean } = {},
	) {
		const result = await poll(async () => {
			const el = await this.find(spec).catch(() => null);
			return gone ? !el : el;
		}, timeout);
		if (!result)
			throw new Error(
				`${gone ? "Still present" : "Not found"} after ${timeout}ms: ${label(spec)}`,
			);
		return result;
	}

	waitForText(text: Matcher, opts?: { timeout?: number; gone?: boolean }) {
		return this.waitFor({ text }, opts);
	}

	async waitForUrl(
		match: Matcher,
		{ timeout = 10_000 }: { timeout?: number } = {},
	) {
		const test = (url: string) =>
			match instanceof RegExp ? match.test(url) : url.includes(match);
		const url = await poll(async () => {
			const { url } = await this.info().catch(() => ({ url: "" }));
			return test(url) && url;
		}, timeout);
		if (!url)
			throw new Error(`URL did not match ${match} within ${timeout}ms`);
		await this.waitForLoad({ until: "dom", timeout }).catch(() => {});
		return url;
	}

	async waitForNetworkIdle({
		idle = 500,
		timeout = 10_000,
	}: { idle?: number; timeout?: number } = {}) {
		// Without the debugger there is no request log; settle for a quiet pause.
		const capturing = await this.via(
			() => this.attach().then(() => true),
			async () => false,
		);
		if (!capturing) {
			await sleep(idle);
			return;
		}
		let quietSince = Date.now();
		let busy: string[] = [];
		const done = await poll(
			async () => {
				const open = pendingRequests(this.tabId);
				if (open.length) {
					quietSince = Date.now();
					busy = open.map((entry) => entry.url);
				}
				return Date.now() - quietSince >= idle;
			},
			timeout,
			100,
		);
		if (!done) {
			const sample = [...new Set(busy)]
				.slice(0, 3)
				.map((url) => url.slice(0, 120))
				.join(", ");
			throw new Error(
				`Network kept busy for ${timeout}ms by: ${sample || "short requests that keep starting"}. Prefer waitFor(spec) for a specific element.`,
			);
		}
	}

	// ── capture ──

	/** Attaches a JPEG to the tool result. Default: what's in view. */
	async screenshot({
		of,
		full = false,
		quality = 70,
	}: { of?: Spec; full?: boolean; quality?: number } = {}) {
		const info = await this.info();
		if (this.mode === "dom")
			return this.fallbackScreenshot(info, { of, full, quality });
		const scale = 1 / info.viewport.dpr;
		let clip: Record<string, number>;
		if (of) {
			const el = await this.resolve(of);
			const r = await this.call<Rect>("rect", el.ref);
			clip = {
				x: r.x,
				y: r.y,
				width: Math.max(1, r.w),
				height: Math.max(1, r.h),
				scale,
			};
		} else if (full) {
			const { cssContentSize } = await this.cdp("Page.getLayoutMetrics");
			clip = {
				x: 0,
				y: 0,
				width: cssContentSize.width,
				height: Math.min(cssContentSize.height, 10_000),
				scale,
			};
		} else {
			clip = {
				x: info.scroll.x,
				y: info.scroll.y,
				width: info.viewport.w,
				height: info.viewport.h,
				scale,
			};
		}

		let data: string;
		try {
			// captureBeyondViewport forces a fresh render, which keeps background tabs from hanging.
			({ data } = await this.cdp(
				"Page.captureScreenshot",
				{ format: "jpeg", quality, clip, captureBeyondViewport: true },
				30_000,
			));
		} catch (error) {
			if (!(error instanceof BlockedError)) throw error;
			fallbackSince.set(this.tabId, Date.now());
			return this.fallbackScreenshot(info, { of, full, quality });
		}
		return this.attachImage(data);
	}

	private attachImage(data: string) {
		this.ctx.images.push({ data, mimeType: "image/jpeg" });
		return `[screenshot ${this.ctx.images.length} attached]`;
	}

	// Without the debugger only the visible part of the tab showing in its window can be captured.
	private async fallbackScreenshot(
		info: PageInfo,
		{ of, full, quality }: { of?: Spec; full: boolean; quality: number },
	) {
		if (full)
			throw new Error(
				"Full-page screenshots need the debugger, which is blocked on this tab",
			);
		const clip = of
			? await this.call<Rect>("viewRect", (await this.resolve(of)).ref)
			: { x: 0, y: 0, w: info.viewport.w, h: info.viewport.h };
		const data = await bridge.call<string>("capture", {
			tabId: this.tabId,
			clip,
			dpr: info.viewport.dpr,
			quality,
		});
		return this.attachImage(data);
	}

	/** fetch() from inside the page, so it carries the page's cookies and origin. */
	async fetch(
		url: string,
		init: {
			method?: string;
			headers?: Record<string, string>;
			body?: unknown;
		} = {},
	) {
		const body =
			init.body !== undefined && typeof init.body !== "string"
				? JSON.stringify(init.body)
				: init.body;
		const res = await this.eval<{
			status: number;
			ok: boolean;
			url: string;
			headers: Record<string, string>;
			text: string;
		}>(
			async (url: string, init: RequestInit) => {
				const r = await fetch(url, { credentials: "include", ...init });
				const headers: Record<string, string> = {};
				r.headers.forEach((value, key) => (headers[key] = value));
				return {
					status: r.status,
					ok: r.ok,
					url: r.url,
					headers,
					text: await r.text(),
				};
			},
			url,
			{ ...init, body },
		);
		return { ...res, json: parseJson(res.text) };
	}
}
