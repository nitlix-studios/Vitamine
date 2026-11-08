import vm from "node:vm";
// Imported as text so `bun --watch` restarts the server when it changes.
import PRELUDE from "./prelude.js" with { type: "text" };

// Script code runs in a fresh JS realm: no Bun, process, require, fetch or filesystem. Everything it
// can reach crosses as JSON. Host objects (Page, El, tabs...) become numbered handles that the
// sandbox sees as proxies, and every host method returns a string, so no host-realm object or
// function (whose .constructor would be the host's Function) ever reaches script code.

const TAG = "$vt";
// Members that could hand back a host Function or prototype.
const BLOCKED = new Set([
	"constructor",
	"prototype",
	"__proto__",
	"__defineGetter__",
	"__defineSetter__",
	"__lookupGetter__",
	"__lookupSetter__",
	"caller",
	"callee",
	"arguments",
	"call",
	"apply",
	"bind",
]);

const message = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

const isPlain = (value: object) => {
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
};

export type Sandboxed = { result: Promise<unknown>; stop: () => void };

export default function sandbox(
	code: string,
	globals: Record<string, unknown>,
): Sandboxed {
	const handles: unknown[] = [];
	const ids = new Map<unknown, number>();
	const timers = new Map<number, Timer>();
	let nextTimer = 1;
	let nextPromise = 1;
	let live = true;
	let settle: ((pid: number, ok: boolean, json: string) => void) | undefined;

	const handle = (value: unknown) => {
		let id = ids.get(value);
		if (id === undefined) {
			id = handles.push(value) - 1;
			ids.set(value, id);
		}
		return id;
	};

	const encode = (value: unknown): unknown => {
		if (value === undefined) return { [TAG]: "u" };
		if (typeof value === "bigint") return String(value);
		if (value === null || (typeof value !== "object" && typeof value !== "function"))
			return value;
		if (value instanceof RegExp)
			return { [TAG]: "re", source: value.source, flags: value.flags };
		if (Array.isArray(value)) return value.map(encode);
		if (typeof value === "object" && isPlain(value))
			return Object.fromEntries(
				Object.entries(value).map(([key, item]) => [key, encode(item)]),
			);
		return { [TAG]: "h", id: handle(value), fn: typeof value === "function" };
	};

	const decode = (json: unknown) => {
		if (typeof json !== "string") throw new Error("Expected JSON from the sandbox");
		return JSON.parse(json, (_key, value) => {
			if (!value || typeof value !== "object" || typeof value[TAG] !== "string")
				return value;
			switch (value[TAG]) {
				case "h":
					return target(value.id);
				case "re":
					return new RegExp(String(value.source), String(value.flags));
				case "fn": {
					// page.eval() only calls toString() on functions to ship them into the page.
					const source = String(value.source);
					return { toString: () => source };
				}
				case "u":
					return undefined;
			}
			return value;
		});
	};

	const target = (id: unknown): any => {
		const index = Number(id);
		if (!Number.isInteger(index) || index < 0 || index >= handles.length)
			throw new Error("Unknown handle");
		return handles[index];
	};

	const member = (prop: unknown) => {
		if (typeof prop !== "string" || BLOCKED.has(prop))
			throw new Error(`"${String(prop)}" is not available in scripts`);
		return prop;
	};

	// Every entry point catches, so the sandbox only ever receives strings.
	const reply = (work: () => unknown) => {
		if (!live) return JSON.stringify({ e: "The script already finished" });
		try {
			return JSON.stringify(work());
		} catch (error) {
			return JSON.stringify({ e: message(error) });
		}
	};

	const deliver = (pid: number, ok: boolean, make: () => unknown) => {
		if (!live || !settle) return;
		let json: string;
		try {
			json = JSON.stringify(make());
		} catch (error) {
			ok = false;
			json = JSON.stringify(message(error));
		}
		try {
			settle(pid, ok, json);
		} catch {}
	};

	let resolveResult!: (value: unknown) => void;
	let rejectResult!: (error: Error) => void;
	const result = new Promise<unknown>((resolve, reject) => {
		resolveResult = resolve;
		rejectResult = reject;
	});

	const host = {
		listen(callback: typeof settle) {
			settle ??= callback;
		},
		get: (id: unknown, prop: unknown) =>
			reply(() => {
				const value = target(id)[member(prop)];
				return typeof value === "function" ? { m: 1 } : { v: encode(value) };
			}),
		set: (id: unknown, prop: unknown, json: unknown) =>
			reply(() => {
				target(id)[member(prop)] = decode(json);
				return {};
			}),
		has: (id: unknown, prop: unknown) =>
			reply(() => ({ v: member(prop) in target(id) })),
		keys: (id: unknown) => reply(() => ({ v: Object.keys(target(id)) })),
		own: (id: unknown, prop: unknown) =>
			reply(() => {
				const self = target(id);
				const key = member(prop);
				return Object.hasOwn(self, key) ? { v: encode(self[key]) } : {};
			}),
		call: (id: unknown, prop: unknown, json: unknown) =>
			reply(() => {
				const self = target(id);
				const args = decode(json);
				if (!Array.isArray(args)) throw new Error("Bad arguments");
				const value =
					prop === null
						? Reflect.apply(self, undefined, args)
						: Reflect.apply(self[member(prop)], self, args);
				if (!(value instanceof Promise)) return { v: encode(value) };

				const pid = nextPromise++;
				value.then(
					(resolved) => deliver(pid, true, () => encode(resolved)),
					(error) => deliver(pid, false, () => message(error)),
				);
				return { p: pid };
			}),
		timer: (ms: unknown, callback: unknown) =>
			reply(() => {
				if (typeof callback !== "function") throw new Error("Bad callback");
				const id = nextTimer++;
				timers.set(
					id,
					setTimeout(() => {
						timers.delete(id);
						if (!live) return;
						try {
							callback();
						} catch {}
					}, Number(ms) || 0),
				);
				return { v: id };
			}),
		clearTimer: (id: unknown) =>
			reply(() => {
				clearTimeout(timers.get(Number(id)));
				timers.delete(Number(id));
				return {};
			}),
		done(ok: unknown, text: unknown) {
			if (!live) return;
			if (ok !== true) {
				rejectResult(new Error(typeof text === "string" ? text : "Script failed"));
				return;
			}
			try {
				resolveResult(decode(text));
			} catch (error) {
				rejectResult(new Error(message(error)));
			}
		},
	};

	// A null-prototype global gives the context its own Object/Function, not the host's.
	const context = vm.createContext(Object.create(null));
	try {
		const start = vm.runInContext(PRELUDE, context, {
			filename: "vitamine-prelude.js",
		});
		start(host, code, JSON.stringify(encode(globals)));
	} catch (error) {
		rejectResult(new Error(message(error)));
	}

	return {
		result,
		stop() {
			live = false;
			for (const timer of timers.values()) clearTimeout(timer);
			timers.clear();
			handles.length = 0;
			ids.clear();
		},
	};
}
