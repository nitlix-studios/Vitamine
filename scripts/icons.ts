import { Resvg } from "@resvg/resvg-js";
import { join } from "node:path";

// Renders the extension's PNG icons from assets/. Run after changing the logo: `bun run icons`.
const ROOT = join(import.meta.dir, "..");
const render = async (source: string, size: number) => {
	const svg = await Bun.file(join(ROOT, "assets", source)).text();
	const png = new Resvg(svg, { fitTo: { mode: "width", value: size } }).render().asPng();
	await Bun.write(join(ROOT, "extension", "icons", `icon-${size}.png`), png);
};

// Toolbar sizes fill the square; the 128px one keeps the Web Store's 16px transparent margin.
await Promise.all([16, 32, 48].map((size) => render("icon.svg", size)));
await render("icon-store.svg", 128);
console.log("Wrote extension/icons/icon-{16,32,48,128}.png");
