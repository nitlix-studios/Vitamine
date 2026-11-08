# WebArena-Verified: Vitamine vs Claude in Chrome vs agent-browser

[WebArena-Verified](https://github.com/ServiceNow/webarena-verified) is ServiceNow's audited release of WebArena, the standard benchmark for browser agents. Every task, reference answer and evaluator has been hand-checked, and scoring is deterministic: no LLM judge.

The model stays fixed (Opus, via a subagent) and only the browser tool changes. Each tool runs the same 30 tasks from the official **Hard** subset.

## How it works

```
subagent ──browser tool──▶ localhost:7770/7780/9999/8023  (proxy.ts: records HAR, injects auto-login)
                                       │
                                       ▼
                           docker containers on 17770/17780/19999/18023
```

- **Sites:** Shopping, Shopping Admin, Reddit (Postmill) and GitLab. Map and Wikipedia are left out because they need about 160 GB of extra data.
- **Grading:** the official evaluator (`webarena-verified==1.2.3`) needs a HAR network trace per task. Claude in Chrome and Vitamine can't export one, so `proxy.ts` records every request at the network layer, the same way for all three tools.
- **Task boundaries:** the agent opens `localhost:7700/start/<id>` to begin a task and `localhost:7700/submit/<id>?r=<json>` to hand in its answer. The proxy writes `runs/<tool>/<id>/{agent_response.json, network.har, meta.json}`.
- **Subset:** `build.ts` takes a stratified sample of 30 tasks (by site and by retrieve/navigate/mutate type) from the Hard subset, at a pinned dataset commit. Read-only tasks run first, so mutations can't change their answers.
- **Fairness:** the subagent types in `.claude/agents/bench-*.md` each have only one browser tool. The proxy flags any request that isn't from a browser, for example curl from the agent-browser agent.

| File | Purpose |
|---|---|
| `sites.ts` | Ports, images, credentials |
| `env.ts` | Colima, image pulls, container up/down/reset/status |
| `build.ts` | Downloads the dataset and builds `data/tasks.json` (no answers) and `data/selection.json` |
| `proxy.ts` | Recording proxy and start/submit control server |
| `prompt.ts` | Builds the run prompt for a tool |
| `eval.ts` | Runs the official evaluator and writes `runs/report.md` |

## One-time setup

```bash
brew install colima docker uv     # skip whatever is already installed
cd benchmarks/webarena-verified
bun env.ts setup                  # starts Colima with Rosetta, pulls ~56 GB of images
bun build.ts                      # writes data/ (deterministic)
```

Colima gets 8 CPUs, 20 GB of RAM and a 160 GB disk. The images are amd64 and run through Rosetta.

## Running (orchestrator: Claude in the main session)

Run the tools one at a time. Vitamine and Claude in Chrome both drive the same real Chrome. For each `TOOL` in `vitamine`, `chrome` and `agent-browser`:

1. `bun env.ts reset` recreates the containers from their images, so every tool starts from identical state. Wait until all four sites report healthy. GitLab can take about 10 minutes.
2. `bun proxy.ts --run TOOL`, in the background.
3. `bun env.ts status` should show every proxy as up.
4. For the Chrome-based tools, close any old localhost tabs and don't use that Chrome until the run ends.
5. `bun prompt.ts TOOL` prints the run prompt and saves it to `runs/TOOL/prompt.md`.
6. Launch the subagent with `Agent({ subagent_type: "bench-TOOL", prompt: <runs/TOOL/prompt.md> })`.
7. Copy the usage figures from the Agent result into `runs/TOOL/usage.json` as `{ "total_tokens": …, "tool_uses": …, "duration_ms": … }`.
8. Stop the proxy.

Then:

```bash
bun eval.ts                       # scores all runs and writes runs/report.md
```

The report shows success rate overall and per task type, tokens, tool calls, agent time, time inside tasks, request counts, and the non-browser flag (should be 0).

## Caveats

- **Noise:** one run per tool is noisy. A few tasks either way is within run-to-run variance, so repeat the runs before trusting small gaps.
- **GitLab login:** GitLab has no header auto-login, so each tool signs in once through the UI. The cost is about the same for every tool.
- **Context length:** 30 tasks in one subagent is long. If a run hits context limits, split the task list in two and use two subagents per tool. The proxy run keeps going across both.
- **Comparison with the leaderboard:** scores here can't be compared with leaderboard numbers. This is a 30-task sample from the Hard subset without Map and Wikipedia, so only the comparison between the three tools is meaningful.
