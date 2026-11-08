// Builds the task subset from the official WebArena-Verified dataset at a pinned commit.
//   bun build.ts [--count 30] [--sites shopping,shopping_admin,reddit,gitlab]
// Writes:
//   data/raw/*              upstream files (contain reference answers — never show to agents)
//   data/tasks.json         agent-facing tasks: id, sites, intent, start urls
//   data/selection.json     ids + task type + strata, for reporting
//   data/sites.md, data/protocol.md   official prompt sections, reused by prompt.ts

import { DATA_DIR, DATASET_COMMIT, SITES, siteUrl } from "./sites";

type Eval = { evaluator: string; expected?: { task_type?: string } };
type RawTask = {
	task_id: number;
	sites: string[];
	intent: string;
	intent_template_id: number;
	start_urls: string[];
	eval: Eval[];
};

const flag = (name: string) => {
	const i = Bun.argv.indexOf(`--${name}`);
	return i === -1 ? undefined : Bun.argv[i + 1];
};

const COUNT = Number(flag("count") ?? 30);
const enabled = new Set(flag("sites")?.split(",") ?? SITES.map((s) => s.id));
const RAW = `https://raw.githubusercontent.com/ServiceNow/webarena-verified/${DATASET_COMMIT}`;

async function fetchRaw(path: string) {
	const res = await fetch(`${RAW}/${path}`);
	if (!res.ok) {
		throw new Error(`${path}: ${res.status}`);
	}
	const text = await res.text();
	await Bun.write(`${DATA_DIR}/raw/${path.split("/").pop()}`, text);
	return text;
}

// Deterministic shuffle so the subset is reproducible across machines.
function shuffle<T>(items: T[], seed: number) {
	const out = [...items];
	let s = seed;
	const rand = () => {
		s = (s + 0x6d2b79f5) | 0;
		let t = Math.imul(s ^ (s >>> 15), 1 | s);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(rand() * (i + 1));
		[out[i], out[j]] = [out[j]!, out[i]!];
	}
	return out;
}

const taskType = (t: RawTask) =>
	t.eval.find((e) => e.evaluator === "AgentResponseEvaluator")?.expected?.task_type ?? "unknown";

const dataset: RawTask[] = JSON.parse(await fetchRaw("assets/dataset/webarena-verified.json"));
const hard: { task_ids: number[] } = JSON.parse(await fetchRaw("assets/dataset/subsets/webarena-verified-hard.json"));
const byId = new Map(dataset.map((t) => [t.task_id, t]));

const pool = hard.task_ids.map((id) => byId.get(id)!).filter((t) => t.sites.every((s) => enabled.has(s)));

// Stratify by site combination × task type, proportional with at least one per stratum.
const strata = new Map<string, RawTask[]>();
for (const t of pool) {
	const key = `${[...t.sites].sort().join("+")}:${taskType(t)}`;
	strata.set(key, [...(strata.get(key) ?? []), t]);
}

const quotas = new Map<string, number>();
for (const [key, tasks] of strata) {
	quotas.set(key, Math.max(1, Math.floor((tasks.length / pool.length) * COUNT)));
}
const byRemainder = [...strata.entries()].sort(
	(a, b) => ((b[1].length / pool.length) * COUNT) % 1 - ((a[1].length / pool.length) * COUNT) % 1,
);
let assigned = [...quotas.values()].reduce((a, b) => a + b, 0);
for (const [key, tasks] of byRemainder) {
	if (assigned >= COUNT) {
		break;
	}
	if (quotas.get(key)! < tasks.length) {
		quotas.set(key, quotas.get(key)! + 1);
		assigned++;
	}
}

// Within a stratum prefer distinct intent templates, so we don't run near-duplicate tasks.
const picked: { task: RawTask; stratum: string }[] = [];
for (const [key, tasks] of strata) {
	const seen = new Set<number>();
	const ordered = shuffle(tasks, 42);
	const distinct = ordered.filter((t) => !seen.has(t.intent_template_id) && seen.add(t.intent_template_id));
	const rest = ordered.filter((t) => !distinct.includes(t));
	for (const task of [...distinct, ...rest].slice(0, quotas.get(key))) {
		picked.push({ task, stratum: key });
	}
}

// Read-only tasks first so earlier mutations can't change their answers.
const typeOrder = ["retrieve", "navigate", "mutate"];
picked.sort(
	(a, b) =>
		typeOrder.indexOf(taskType(a.task)) - typeOrder.indexOf(taskType(b.task)) ||
		a.stratum.localeCompare(b.stratum) ||
		a.task.task_id - b.task.task_id,
);

const render = (url: string) => SITES.reduce((u, s) => u.replaceAll(s.placeholder, siteUrl(s)), url);

await Bun.write(
	`${DATA_DIR}/tasks.json`,
	JSON.stringify(
		picked.map(({ task }) => ({
			id: task.task_id,
			sites: task.sites,
			intent: task.intent,
			start_urls: task.start_urls.map(render),
		})),
		null,
		"\t",
	),
);

await Bun.write(
	`${DATA_DIR}/selection.json`,
	JSON.stringify(
		{
			dataset_commit: DATASET_COMMIT,
			subset: "webarena-verified-hard",
			count: picked.length,
			tasks: picked.map(({ task, stratum }) => ({ id: task.task_id, type: taskType(task), stratum })),
		},
		null,
		"\t",
	),
);

// Reuse the official per-site prompt text: the "Site Context" bullets and the shared rules after "## Task Types".
const contexts: string[] = [];
let protocol = "";
for (const site of SITES.filter((s) => enabled.has(s.id))) {
	const md = await fetchRaw(`examples/prompts/${site.id}.md`);
	const context = md.split("## Site Context")[1]!.split("## Task Input")[0]!.trim();
	const platform = context.match(/Platform: (.+)/)![1];
	contexts.push(`### ${platform} (${siteUrl(site)})\n${context}`);
	protocol = `## Task Types${md.split("## Task Types")[1]}`;
}

await Bun.write(`${DATA_DIR}/sites.md`, contexts.join("\n\n"));
await Bun.write(`${DATA_DIR}/protocol.md`, protocol.trim());

console.log(`selected ${picked.length} tasks from ${pool.length} eligible hard tasks`);
for (const [key, n] of quotas) {
	console.log(`  ${key.padEnd(32)} ${n}/${strata.get(key)!.length}`);
}
