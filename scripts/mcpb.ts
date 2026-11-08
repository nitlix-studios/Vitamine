import { $ } from "bun";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import pkg from "../package.json";

// Builds dist/vitamine.mcpb for Claude Desktop. Local-only for now: the bundle points back at this checkout
// and this machine's bun, so rebuild it if either moves.
const ROOT = join(import.meta.dir, "..");
const STAGE = join(ROOT, "dist", "mcpb");
const OUT = join(ROOT, "dist", "vitamine.mcpb");

rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });

await Bun.write(
	join(STAGE, "launch.ts"),
	`import ${JSON.stringify(join(ROOT, "server", "stdio.ts"))};\n`,
);

await Bun.write(
	join(STAGE, "manifest.json"),
	JSON.stringify(
		{
			manifest_version: "0.2",
			name: "vitamine",
			display_name: "Vitamine",
			version: pkg.version,
			description: "Drive your own Chrome, with your logins, through the Vitamine extension.",
			author: { name: "Nitlix" },
			license: pkg.license,
			server: {
				type: "binary",
				entry_point: "launch.ts",
				mcp_config: {
					command: process.execPath,
					args: ["run", "${__dirname}/launch.ts"],
					env: {},
				},
			},
			tools: [
				{ name: "tabs", description: "List and manage browser tabs" },
				{ name: "run", description: "Run a script against a tab" },
				{ name: "scripts_list", description: "List saved scripts" },
				{ name: "scripts_save", description: "Save a reusable script" },
			],
			tools_generated: true,
		},
		null,
		2,
	),
);

await $`bunx @anthropic-ai/mcpb pack ${STAGE} ${OUT}`;
console.log(`Built ${OUT}. Open it (or drag into Claude Desktop → Settings → Extensions) to install.`);
