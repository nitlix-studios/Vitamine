import { $ } from "bun";
import { join } from "node:path";

// Cuts a release: `bun run release 0.2.0` (or patch / minor / major).
// Bumps package.json and the extension manifest together, commits, tags v<version> and pushes.
// The tag push triggers .github/workflows/release.yml, which publishes everything.
const ROOT = join(import.meta.dir, "..");
const PKG = join(ROOT, "package.json");
const MANIFEST = join(ROOT, "extension", "manifest.json");

const pkg = await Bun.file(PKG).json();
const arg = process.argv[2];
if (!arg) {
	console.error("Usage: bun run release <version | patch | minor | major>");
	process.exit(1);
}

const [major, minor, patch] = pkg.version.split(".").map(Number);
const version =
	arg === "major"
		? `${major + 1}.0.0`
		: arg === "minor"
			? `${major}.${minor + 1}.0`
			: arg === "patch"
				? `${major}.${minor}.${patch + 1}`
				: arg;
if (!/^\d+\.\d+\.\d+$/.test(version)) {
	console.error(`"${version}" isn't a version (Chrome only accepts plain x.y.z)`);
	process.exit(1);
}

if ((await $`git status --porcelain --untracked-files=no`.cwd(ROOT).text()).trim()) {
	console.error("Commit or stash your changes first.");
	process.exit(1);
}

await $`bun run typecheck`.cwd(ROOT);

// Edit the version strings in place so the files keep their formatting.
const bump = async (path: string) => {
	const text = await Bun.file(path).text();
	await Bun.write(path, text.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`));
};
await bump(PKG);
await bump(MANIFEST);

await $`git add ${PKG} ${MANIFEST}`.cwd(ROOT);
await $`git commit -m ${`release: v${version}`}`.cwd(ROOT);
await $`git tag v${version}`.cwd(ROOT);
await $`git push origin HEAD v${version}`.cwd(ROOT);
console.log(`Pushed v${version}. Follow it at https://github.com/nitlix-studios/Vitamine/actions`);
