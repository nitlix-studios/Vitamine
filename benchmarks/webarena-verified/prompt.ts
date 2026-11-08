// Prints the run prompt the orchestrator hands to a bench-* subagent, and saves it to runs/<tool>/prompt.md.
//   bun prompt.ts vitamine|chrome|agent-browser

import { mkdirSync } from "node:fs";
import { CONTROL_PORT, DATA_DIR, RUNS_DIR, TOOLS, type Tool } from "./sites";

const tool = Bun.argv[2] as Tool;
if (!TOOLS.includes(tool)) {
	console.error(`usage: bun prompt.ts ${TOOLS.join("|")}`);
	process.exit(1);
}

const tasks: { id: number; intent: string; start_urls: string[] }[] = await Bun.file(`${DATA_DIR}/tasks.json`).json();
const sites = await Bun.file(`${DATA_DIR}/sites.md`).text();
// The official rules, minus the JSON-reply instruction: answers go through the submit URL instead.
const protocol = (await Bun.file(`${DATA_DIR}/protocol.md`).text()).replace(
	"When the task is complete, return a JSON response with the following structure:",
	"When the task is complete, submit a JSON response with the following structure:",
);
const control = `http://localhost:${CONTROL_PORT}`;

const prompt = `You are running the WebArena-Verified benchmark: ${tasks.length} tasks, one after another, in the order listed. Work autonomously; nobody will answer questions.

# Procedure for every task
1. Open ${control}/start/<id> in your browser. It begins recording and redirects to the task's start URL.
2. Complete the task using only your browser tool.
3. Open ${control}/submit/<id>?r=<response JSON, URL-encoded>. A "Saved task <id>" page confirms it. If you get "Invalid response", fix the JSON and open the submit URL again.
4. Move on to the next task. Never revisit a task you already submitted.

If a task is going nowhere after a reasonable effort, submit your best answer or an error status and move on. Do not stop early; finish all ${tasks.length} tasks.

# Sites
All sites run locally. You start signed in on every site except possibly GitLab; if a page asks you to sign in, use the credentials below.

${sites}

# Rules for every task
- Start URLs give context: if one points to a specific page, the objective relates to that page or section.
- Stay within the sites above. Do not use any outside website or search engine.
- Avoid changing state unless the objective requires it.
- Do not download files.

${protocol}

# Tasks
${tasks.map((t) => `- **${t.id}**: ${t.intent}\n  Start URL: ${t.start_urls.join(", ")}`).join("\n")}

# Final report
When all tasks are submitted, reply with one line per task: \`<id> <status> <~number of browser tool calls>\`, then any problems you hit with your browser tool.`;

mkdirSync(`${RUNS_DIR}/${tool}`, { recursive: true });
await Bun.write(`${RUNS_DIR}/${tool}/prompt.md`, prompt);
console.log(prompt);
