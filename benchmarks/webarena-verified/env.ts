// Docker lifecycle for the WebArena-Verified sites.
//   bun env.ts setup            start Colima (Rosetta) and pull all images (~56GB)
//   bun env.ts up|down|reset    start / remove / recreate containers (reset = fresh state from the image)
//   bun env.ts status
// Add --sites shopping,reddit to limit to some sites.

import { $ } from "bun";
import { containerName, SITES, siteUrl, type Site } from "./sites";

const [command] = Bun.argv.slice(2);
const sitesFlag = Bun.argv.indexOf("--sites");
const selected = sitesFlag === -1 ? SITES : SITES.filter((s) => Bun.argv[sitesFlag + 1]!.split(",").includes(s.id));

async function setup() {
	const running = await $`colima status`.quiet().nothrow();
	if (running.exitCode !== 0) {
		// The site images are linux/amd64; Rosetta runs them far faster than QEMU.
		await $`colima start --cpu 8 --memory 20 --disk 160 --vm-type vz --vz-rosetta`;
	}

	for (const site of selected) {
		console.log(`pulling ${site.image}`);
		await $`docker pull ${site.image}`;
	}
}

async function down() {
	for (const site of selected) {
		await $`docker rm -f ${containerName(site)}`.quiet().nothrow();
	}
}

async function waitHealthy(site: Site, timeoutMs: number) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const res = await fetch(`http://127.0.0.1:${site.upstreamPort}${site.healthPath}`, {
			headers: { host: `localhost:${site.port}` },
			redirect: "manual",
		}).catch(() => null);
		if (res && res.status < 500) {
			return true;
		}
		await Bun.sleep(5000);
	}
	return false;
}

async function up() {
	await down();
	for (const site of selected) {
		// Bound to 127.0.0.1 on the upstream port; the recording proxy owns the canonical port.
		await $`docker run -d --name ${containerName(site)} \
			-p 127.0.0.1:${site.upstreamPort}:${site.containerPort} \
			-p 127.0.0.1:${site.envCtrlPort}:8877 \
			-e WA_ENV_CTRL_EXTERNAL_SITE_URL=${siteUrl(site)} \
			${site.image}`.quiet();
		console.log(`started ${site.id}`);
	}

	for (const site of selected) {
		// GitLab takes several minutes to boot under Rosetta.
		const healthy = await waitHealthy(site, 20 * 60_000);
		console.log(`${site.id}: ${healthy ? "healthy" : "NOT healthy (check docker logs)"}`);
	}
}

async function status() {
	for (const site of selected) {
		const state = await $`docker inspect -f {{.State.Status}} ${containerName(site)}`.quiet().nothrow();
		const proxied = await fetch(`${siteUrl(site)}${site.healthPath}`, { redirect: "manual" }).catch(() => null);
		console.log(
			`${site.id.padEnd(15)} container=${state.exitCode === 0 ? state.stdout.toString().trim() : "missing"} proxy=${proxied?.status ?? "down"}`,
		);
	}
}

const commands: Record<string, () => Promise<unknown>> = {
	setup,
	up,
	down,
	reset: up,
	status,
};

if (!command || !commands[command]) {
	console.error("usage: bun env.ts setup|up|down|reset|status [--sites a,b]");
	process.exit(1);
}

await commands[command]();
