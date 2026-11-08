// Runs inside the script sandbox (see sandbox.ts) as one function expression: no imports, no TypeScript.
// It turns host handles into proxies and talks to the host only in JSON strings. `host` stays in this
// closure: script code is compiled with AsyncFunction, so it can't see it. Strict mode keeps
// `fn.caller` from walking out of script code into these functions.
(function (host, code, globalsJson) {
	"use strict";

	const TAG = "$vt";
	const GLOBALS = ["page", "tabs", "net", "cookies", "logs", "scripts", "sleep", "log", "args"];
	const { parse, stringify } = JSON;
	const then = Promise.prototype.then;
	const AsyncFunction = (async () => {}).constructor;
	const proxies = new Map();
	const ids = new WeakMap();
	const pending = new Map();

	function revive(_key, value) {
		if (!value || typeof value !== "object" || typeof value[TAG] !== "string") return value;
		if (value[TAG] === "h") return proxy(value.id, value.fn);
		if (value[TAG] === "re") return new RegExp(value.source, value.flags);
		if (value[TAG] === "u") return undefined;
		return value;
	}

	function encode(value) {
		if (value === undefined) return { [TAG]: "u" };
		if (value === null || (typeof value !== "object" && typeof value !== "function")) return value;
		const id = ids.get(value);
		if (id !== undefined) return { [TAG]: "h", id };
		if (value instanceof RegExp) return { [TAG]: "re", source: value.source, flags: value.flags };
		// page.eval(fn) only needs the source; it runs in the page, not here.
		if (typeof value === "function") return { [TAG]: "fn", source: String(value) };
		if (typeof value.toJSON === "function") return encode(value.toJSON());
		if (Array.isArray(value)) return value.map(encode);
		const out = {};
		for (const key of Object.keys(value)) out[key] = encode(value[key]);
		return out;
	}

	// Host methods return JSON; failures come back as {e}, so no host Error object is ever caught here.
	function ask(method, ...args) {
		let reply;
		try {
			reply = parse(host[method](...args), revive);
		} catch {
			throw new Error(`Vitamine host call "${method}" failed`);
		}
		if (reply && "e" in reply) throw new Error(reply.e);
		return reply;
	}

	function invoke(id, prop, args) {
		const reply = ask("call", id, prop, stringify(encode(args)));
		if (!("p" in reply)) return reply.v;
		return new Promise((resolve, reject) => pending.set(reply.p, { resolve, reject }));
	}

	function proxy(id, callable) {
		const known = proxies.get(id);
		if (known) return known;

		const made = new Proxy(callable ? () => {} : {}, {
			get(_target, prop) {
				// "then" must stay undefined, or awaiting a page or element would hang.
				if (typeof prop !== "string" || prop === "then") return undefined;
				const reply = ask("get", id, prop);
				return "m" in reply ? (...args) => invoke(id, prop, args) : reply.v;
			},
			set(_target, prop, value) {
				if (typeof prop !== "string") return false;
				ask("set", id, prop, stringify(encode(value)));
				return true;
			},
			has(_target, prop) {
				return typeof prop === "string" && ask("has", id, prop).v;
			},
			ownKeys() {
				return ask("keys", id).v;
			},
			getOwnPropertyDescriptor(_target, prop) {
				if (typeof prop !== "string") return undefined;
				const reply = ask("own", id, prop);
				if (!("v" in reply)) return undefined;
				return { value: reply.v, writable: true, enumerable: true, configurable: true };
			},
			apply(_target, _self, args) {
				return invoke(id, null, args);
			},
		});
		proxies.set(id, made);
		ids.set(made, id);
		return made;
	}

	function settle(pid, ok, json) {
		const waiting = pending.get(pid);
		if (!waiting) return;
		pending.delete(pid);
		if (ok) waiting.resolve(parse(json, revive));
		else waiting.reject(new Error(parse(json)));
	}

	function compile(source) {
		// A lone expression returns its value (REPL-style); otherwise the code needs an explicit `return`.
		try {
			return new AsyncFunction(...GLOBALS, `return (${source.trim().replace(/;+$/, "")}\n);`);
		} catch {
			return new AsyncFunction(...GLOBALS, source);
		}
	}

	let finished = false;
	function finish(ok, text) {
		if (finished) return;
		finished = true;
		host.done(ok, text);
	}

	// Bun's ShadowRealm builds a realm with Bun and process in it, which would undo the sandbox.
	delete globalThis.ShadowRealm;

	try {
		host.listen(settle);
		const env = parse(globalsJson, revive);
		const saved = env.scripts;
		env.scripts = {
			list: () => saved.list(),
			async run(name, scriptArgs = {}) {
				const fn = compile(await saved.load(name));
				return fn(...GLOBALS.map((name) => (name === "args" ? scriptArgs : env[name])));
			},
		};

		const out = (...items) => env.log(...items);
		globalThis.console = { log: out, info: out, warn: out, error: out, debug: out };
		globalThis.setTimeout = (callback, ms, ...rest) =>
			ask("timer", Number(ms) || 0, () => callback(...rest)).v;
		globalThis.clearTimeout = (timer) => {
			ask("clearTimer", timer);
		};

		const fn = compile(code);
		then.call(
			(async () => await fn(...GLOBALS.map((name) => env[name])))(),
			(value) => {
				let json;
				try {
					json = stringify(encode(value));
				} catch (error) {
					finish(false, `Return value could not be serialized: ${error?.message ?? error}`);
					return;
				}
				finish(true, json);
			},
			(error) => {
				let text;
				try {
					text = error instanceof Error ? error.message : String(error);
				} catch {
					text = "Script threw a value that can't be shown";
				}
				finish(false, text);
			},
		);
	} catch (error) {
		finish(false, error instanceof Error ? error.message : String(error));
	}
});
