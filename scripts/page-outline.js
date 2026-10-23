// Headings and links of the current page. args: {limit?: number}
const limit = args.limit ?? 10;
const headings = (await page.findAll({ role: "heading" }, { limit })).map(
	(h) => h.name,
);
const links = (await page.findAll({ role: "link" }, { limit })).map(
	(l) => l.name,
);
return { url: (await page.info()).url, headings, links };
