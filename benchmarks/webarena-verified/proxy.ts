// Recording reverse proxy. Owns the canonical site ports, forwards to the containers, injects the
// auto-login headers, and writes one HAR per task — so every browser tool is graded identically,
// whether or not it can export network traces itself.
//
//   bun proxy.ts --run vitamine
//
// Agents drive it with plain navigations on the control port:
//   GET /start/:id                 begin recording task :id, 302 to its start URL
//   GET /submit/:id?r=<json>       save the agent response + HAR, stop recording
// Output: runs/<run>/<id>/{agent_response.json, network.har, meta.json}

import { mkdirSync } from "node:fs";
import { CONTROL_PORT, DATA_DIR, RUNS_DIR, SITES, type Site } from "./sites";

type HarHeader = { name: string; value: string };
type Recording = { id: number; startedAt: number; entries: unknown[]; nonBrowser: number };
type Task = { id: number; start_urls: string[] };

const runFlag = Bun.argv.indexOf("--run");
if (runFlag === -1) {
	console.error("usage: bun proxy.ts --run <name>");
	process.exit(1);
}
const RUN = Bun.argv[runFlag + 1]!;
const OUT = `${RUNS_DIR}/${RUN}`;
const tasks: Task[] = await Bun.file(`${DATA_DIR}/tasks.json`).json();
const taskIds = tasks.map((t) => t.id);

let current: Recording | null = null;
mkdirSync(OUT, { recursive: true });
const unassigned = Bun.file(`${OUT}/_unassigned.log`).writer();

const headerList = (headers: Headers): HarHeader[] => {
	const list: HarHeader[] = [];
	headers.forEach((value, name) => {
		if (name !== "set-cookie") {
			list.push({ name, value });
		}
	});
	for (const cookie of headers.getSetCookie()) {
		list.push({ name: "set-cookie", value: cookie });
	}
	return list;
};

const isText = (mime: string) => /json|x-www-form-urlencoded|multipart\/form-data|text\/plain|xml/.test(mime);

async function forward(req: Request, site: Site) {
	const url = new URL(req.url);
	const headers = new Headers(req.headers);
	headers.delete("accept-encoding"); // keep bodies uncompressed so they can be recorded
	if (site.autoLogin) {
		headers.set(site.autoLogin.header, site.autoLogin.value);
	}

	const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
	const started = Date.now();
	const upstream = await fetch(`http://127.0.0.1:${site.upstreamPort}${url.pathname}${url.search}`, {
		method: req.method,
		headers,
		body,
		redirect: "manual",
		signal: AbortSignal.timeout(300_000),
	});
	const buf = await upstream.arrayBuffer();

	const resHeaders = new Headers(upstream.headers);
	for (const h of ["content-encoding", "content-length", "transfer-encoding", "connection"]) {
		resHeaders.delete(h);
	}

	record(req, url, body, upstream, buf, started);
	return new Response(buf, { status: upstream.status, statusText: upstream.statusText, headers: resHeaders });
}

function record(req: Request, url: URL, body: ArrayBuffer | undefined, res: Response, buf: ArrayBuffer, started: number) {
	const reqMime = req.headers.get("content-type") ?? "";
	const resMime = res.headers.get("content-type") ?? "";
	const entry = {
		startedDateTime: new Date(started).toISOString(),
		time: Date.now() - started,
		request: {
			method: req.method,
			url: url.href,
			httpVersion: "HTTP/1.1",
			cookies: [],
			headers: headerList(req.headers), // as sent by the browser, without the injected login header
			queryString: [...url.searchParams].map(([name, value]) => ({ name, value })),
			...(body && { postData: { mimeType: reqMime, text: new TextDecoder().decode(body) } }),
			headersSize: -1,
			bodySize: body?.byteLength ?? 0,
		},
		response: {
			status: res.status,
			statusText: res.statusText,
			httpVersion: "HTTP/1.1",
			cookies: res.headers.getSetCookie().map((c) => {
				const [pair] = c.split(";");
				const eq = pair!.indexOf("=");
				return { name: pair!.slice(0, eq).trim(), value: pair!.slice(eq + 1).trim() };
			}),
			headers: headerList(res.headers),
			content: {
				size: buf.byteLength,
				mimeType: resMime,
				...(isText(resMime) && { text: new TextDecoder().decode(buf) }),
			},
			redirectURL: res.headers.get("location") ?? "",
			headersSize: -1,
			bodySize: buf.byteLength,
		},
		cache: {},
		timings: { send: 0, wait: Date.now() - started, receive: 0 },
	};

	if (!current) {
		unassigned.write(`${entry.startedDateTime} ${req.method} ${url.href}\n`);
		return;
	}
	current.entries.push(entry);
	// Flags requests that didn't come from a browser (e.g. curl), which would break the rules.
	if (!(req.headers.get("user-agent") ?? "").includes("Mozilla")) {
		current.nonBrowser++;
	}
}

async function finish(rec: Recording, response: unknown) {
	const dir = `${OUT}/${rec.id}`;
	mkdirSync(dir, { recursive: true });
	const endedAt = Date.now();
	await Bun.write(`${dir}/agent_response.json`, JSON.stringify(response, null, "\t"));
	await Bun.write(
		`${dir}/network.har`,
		JSON.stringify({ log: { version: "1.2", creator: { name: "vitamine-bench-proxy", version: "1" }, entries: rec.entries } }),
	);
	await Bun.write(
		`${dir}/meta.json`,
		JSON.stringify(
			{
				task_id: rec.id,
				started_at: new Date(rec.startedAt).toISOString(),
				ended_at: new Date(endedAt).toISOString(),
				duration_ms: endedAt - rec.startedAt,
				requests: rec.entries.length,
				non_browser_requests: rec.nonBrowser,
			},
			null,
			"\t",
		),
	);
}

const page = (title: string, body: string, status = 200) =>
	new Response(`<!doctype html><title>${title}</title><h1>${title}</h1>${body}`, {
		status,
		headers: { "content-type": "text/html; charset=utf-8" },
	});

// Tolerates both encoded and raw JSON after `r=`, since agents build this URL by hand.
function parseResponse(url: URL) {
	const raw = url.search.match(/[?&]r=(.*)$/s)?.[1] ?? "";
	const decoders = [() => decodeURIComponent(raw), () => url.searchParams.get("r") ?? "", () => raw];
	for (const decode of decoders) {
		try {
			return JSON.parse(decode());
		} catch {}
	}
	return null;
}

async function control(req: Request) {
	const url = new URL(req.url);
	const [, action, idRaw] = url.pathname.split("/");
	const id = Number(idRaw);

	if (action === "start") {
		const task = tasks.find((t) => t.id === id);
		if (!task) {
			return page("Unknown task", `<p>Task ${idRaw} is not in this run.</p>`, 404);
		}
		if (current && current.id !== id) {
			console.log(`task ${current.id} abandoned without submit`);
			await finish(current, { task_type: "RETRIEVE", status: "UNKNOWN_ERROR", retrieved_data: null, error_details: "not submitted" });
		}
		if (!current || current.id !== id) {
			current = { id, startedAt: Date.now(), entries: [], nonBrowser: 0 };
			console.log(`task ${id} started`);
		}
		return Response.redirect(task.start_urls[0]!, 302);
	}

	if (action === "submit") {
		if (!current || current.id !== id) {
			return page("Not started", `<p>Task ${idRaw} is not running. Open /start/${idRaw} first.</p>`, 409);
		}
		const response = parseResponse(url);
		if (!response || typeof response !== "object" || !("task_type" in response) || !("status" in response)) {
			return page(
				"Invalid response",
				`<p>Could not parse a JSON object with task_type and status from the r parameter. Fix it and open this URL again; task ${id} is still running.</p>`,
				400,
			);
		}
		const done = current;
		current = null;
		await finish(done, response);
		console.log(`task ${id} submitted`);
		const next = taskIds[taskIds.indexOf(id) + 1];
		return page(
			`Saved task ${id}`,
			`<p>${taskIds.indexOf(id) + 1}/${taskIds.length} done.</p>${next ? `<p>Next task: ${next}</p>` : "<p>That was the last task.</p>"}`,
		);
	}

	return page("WebArena-Verified proxy", `<p>Run: ${RUN}. Recording: ${current?.id ?? "nothing"}.</p>`);
}

for (const site of SITES) {
	Bun.serve({
		port: site.port,
		idleTimeout: 255, // slow GitLab pages under Rosetta would trip the 10s default
		maxRequestBodySize: 512 * 1024 * 1024,
		fetch: (req) => forward(req, site).catch((e) => new Response(`proxy error: ${e}`, { status: 502 })),
	});
}
Bun.serve({ port: CONTROL_PORT, fetch: control });

console.log(`recording run "${RUN}" → ${OUT}`);
console.log(`sites: ${SITES.map((s) => `${s.id}:${s.port}→${s.upstreamPort}`).join("  ")}  control:${CONTROL_PORT}`);
