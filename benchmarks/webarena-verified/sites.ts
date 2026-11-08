// WebArena-Verified sites we run. Map and Wikipedia are excluded: they need ~160GB of extra data volumes.
// Browsers talk to the recording proxy on `port`; the container itself listens on `upstreamPort`.

export type SiteId = "shopping" | "shopping_admin" | "reddit" | "gitlab";

export type Site = {
	id: SiteId;
	placeholder: string;
	port: number;
	upstreamPort: number;
	containerPort: number;
	envCtrlPort: number;
	image: string;
	healthPath: string;
	// Header-based login built into the verified images; the proxy injects it so every tool starts signed in.
	autoLogin?: { header: string; value: string };
	credentials: { username: string; password: string };
};

export const DATASET_COMMIT = "6473f72db5dcefc97b5725b59e734504edc28a21";
export const CONTROL_PORT = 7700;

export const SITES: Site[] = [
	{
		id: "shopping",
		placeholder: "__SHOPPING__",
		port: 7770,
		upstreamPort: 17770,
		containerPort: 80,
		envCtrlPort: 7771,
		image: "am1n3e/webarena-verified-shopping",
		healthPath: "/",
		autoLogin: { header: "X-M2-Customer-Auto-Login", value: "emma.lopez@gmail.com:Password.123" },
		credentials: { username: "emma.lopez@gmail.com", password: "Password.123" },
	},
	{
		id: "shopping_admin",
		placeholder: "__SHOPPING_ADMIN__",
		port: 7780,
		upstreamPort: 17780,
		containerPort: 80,
		envCtrlPort: 7781,
		image: "am1n3e/webarena-verified-shopping_admin",
		healthPath: "/admin",
		autoLogin: { header: "X-M2-Admin-Auto-Login", value: "admin:admin1234" },
		credentials: { username: "admin", password: "admin1234" },
	},
	{
		id: "reddit",
		placeholder: "__REDDIT__",
		port: 9999,
		upstreamPort: 19999,
		containerPort: 80,
		envCtrlPort: 9998,
		image: "am1n3e/webarena-verified-reddit",
		healthPath: "/",
		autoLogin: { header: "X-Postmill-Auto-Login", value: "MarvelsGrantMan136:test1234" },
		credentials: { username: "MarvelsGrantMan136", password: "test1234" },
	},
	{
		id: "gitlab",
		placeholder: "__GITLAB__",
		port: 8023,
		upstreamPort: 18023,
		containerPort: 8023,
		envCtrlPort: 8024,
		image: "am1n3e/webarena-verified-gitlab",
		healthPath: "/users/sign_in",
		credentials: { username: "byteblaze", password: "hello1234" },
	},
];

export const siteUrl = (site: Site) => `http://localhost:${site.port}`;
export const containerName = (site: Site) => `webarena-verified-${site.id}`;

export const ROOT = import.meta.dir;
export const DATA_DIR = `${ROOT}/data`;
export const RUNS_DIR = `${ROOT}/runs`;
export const TOOLS = ["vitamine", "chrome", "agent-browser"] as const;
export type Tool = (typeof TOOLS)[number];
