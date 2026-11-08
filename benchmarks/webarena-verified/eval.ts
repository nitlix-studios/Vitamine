// Scores recorded runs with the official evaluator, then writes runs/report.md.
//   bun eval.ts [vitamine chrome agent-browser]
// Tasks a run never submitted count as failures.

import { $ } from "bun";
import { existsSync, readdirSync } from "node:fs";
import { DATA_DIR, RUNS_DIR, SITES, siteUrl, TOOLS } from "./sites";

const EVALUATOR = "webarena-verified==1.2.3"; // matches DATASET_COMMIT

type Selection = { tasks: { id: number; type: string; stratum: string }[] };
type Meta = { duration_ms: number; requests: number; non_browser_requests: number };
type Usage = { total_tokens?: number; tool_uses?: number; duration_ms?: number };

const selection: Selection = await Bun.file(`${DATA_DIR}/selection.json`).json();
const args = Bun.argv.slice(2);
const runs = (args.length ? args : [...TOOLS]).filter((t) => existsSync(`${RUNS_DIR}/${t}`));

const configPath = `${DATA_DIR}/eval-config.json`;
await Bun.write(
	configPath,
	JSON.stringify({
		environments: Object.fromEntries(
			SITES.map((s) => [
				s.placeholder,
				{ urls: [siteUrl(s)], active_url_idx: 0, credentials: s.credentials },
			]),
		),
	}),
);

const readJson = async <T>(path: string): Promise<T | null> =>
	existsSync(path) ? Bun.file(path).json() : null;

const rows: string[] = [];
const types = [...new Set(selection.tasks.map((t) => t.type))];

for (const run of runs) {
	const dir = `${RUNS_DIR}/${run}`;
	const submitted = readdirSync(dir).filter((d) => /^\d+$/.test(d));
	if (submitted.length) {
		await $`uvx ${EVALUATOR} eval-tasks --config ${configPath} --output-dir ${dir} --task-ids ${submitted.join(",")}`.nothrow();
	}

	let passed = 0;
	let durationMs = 0;
	let requests = 0;
	let flagged = 0;
	const byType: Record<string, [number, number]> = {};
	for (const task of selection.tasks) {
		const result = await readJson<{ score: number }>(`${dir}/${task.id}/eval_result.json`);
		const meta = await readJson<Meta>(`${dir}/${task.id}/meta.json`);
		const ok = (result?.score ?? 0) === 1;
		passed += ok ? 1 : 0;
		durationMs += meta?.duration_ms ?? 0;
		requests += meta?.requests ?? 0;
		flagged += meta?.non_browser_requests ?? 0;
		const [p, n] = byType[task.type] ?? [0, 0];
		byType[task.type] = [p + (ok ? 1 : 0), n + 1];
	}

	// usage.json is written by the orchestrator from the subagent's final usage report.
	const usage = (await readJson<Usage>(`${dir}/usage.json`)) ?? {};
	const total = selection.tasks.length;
	rows.push(
		[
			run,
			`${passed}/${total} (${Math.round((passed / total) * 100)}%)`,
			...types.map((t) => `${byType[t]![0]}/${byType[t]![1]}`),
			usage.total_tokens?.toLocaleString() ?? "–",
			usage.tool_uses ?? "–",
			usage.duration_ms ? `${Math.round(usage.duration_ms / 60_000)}m` : "–",
			`${Math.round(durationMs / 60_000)}m`,
			requests,
			flagged ? `⚠ ${flagged}` : "0",
		].join(" | "),
	);
}

const report = [
	`# WebArena-Verified results (${selection.tasks.length} hard tasks)`,
	"",
	`| Tool | Success | ${types.join(" | ")} | Tokens | Tool calls | Agent time | Task time | Requests | Non-browser requests |`,
	`|${" --- |".repeat(8 + types.length)}`,
	...rows.map((r) => `| ${r} |`),
	"",
	"Agent time comes from the subagent's usage report; task time is the sum of /start→/submit windows recorded by the proxy.",
	"Non-browser requests should be 0 — anything else means the agent hit a site outside its browser tool.",
].join("\n");

await Bun.write(`${RUNS_DIR}/report.md`, report);
console.log(report);
