import { $ } from "bun";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

// Packs the extension for the Chrome Web Store: dist/vitamine-extension-<version>.zip.
// The store assigns its own ID and rejects a manifest `key`, so it's stripped here.
const ROOT = join(import.meta.dir, "..");
const EXT = join(ROOT, "extension");
const STAGE = join(ROOT, "dist", "extension");

await $`bun run build`.cwd(ROOT).quiet();

const manifest = await Bun.file(join(EXT, "manifest.json")).json();
delete manifest.key;

rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });
cpSync(join(EXT, "dist"), join(STAGE, "dist"), { recursive: true });
cpSync(join(EXT, "icons"), join(STAGE, "icons"), { recursive: true });
await Bun.write(join(STAGE, "manifest.json"), `${JSON.stringify(manifest, null, "\t")}\n`);

const out = join(ROOT, "dist", `vitamine-extension-${manifest.version}.zip`);
rmSync(out, { force: true });
await $`zip -qr ${out} .`.cwd(STAGE);
console.log(`Built ${out}`);
