import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

const DIR = join(import.meta.dir, "..", "scripts");
const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

function pathFor(name: string) {
	if (!NAME.test(name))
		throw new Error(
			`Script names use letters, digits, - and _ (got "${name}")`,
		);
	return join(DIR, `${name}.js`);
}

export async function saveScript(
	name: string,
	description: string,
	code: string,
) {
	await mkdir(DIR, { recursive: true });
	const path = pathFor(name);
	await Bun.write(
		path,
		`// ${description.replace(/\s+/g, " ").trim()}\n${code.trim()}\n`,
	);
	return path;
}

export async function loadScript(name: string) {
	const file = Bun.file(pathFor(name));
	if (!(await file.exists())) {
		const saved =
			(await listScripts()).map((s) => s.name).join(", ") || "none";
		throw new Error(`No saved script "${name}". Saved: ${saved}`);
	}
	return file.text();
}

export async function listScripts() {
	await mkdir(DIR, { recursive: true });
	const files = (await readdir(DIR))
		.filter((file) => file.endsWith(".js"))
		.sort();
	return Promise.all(
		files.map(async (file) => {
			const [first = ""] = (await Bun.file(join(DIR, file)).text()).split(
				"\n",
				1,
			);
			return {
				name: file.slice(0, -3),
				description: first.startsWith("//")
					? first.slice(2).trim()
					: "",
			};
		}),
	);
}
