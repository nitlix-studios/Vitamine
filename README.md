<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/nitlix-studios/Vitamine/main/assets/wordmark-white.svg">
    <img alt="Vitamine" src="https://raw.githubusercontent.com/nitlix-studios/Vitamine/main/assets/wordmark-black.svg" height="48">
  </picture>
</h1>

Let your AI agent drive your real browser. Your tabs, your cookies, your logins.

<p>
  <a href="https://github.com/nitlix-studios/Vitamine/blob/main/LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/github/license/nitlix-studios/Vitamine.svg?style=for-the-badge&labelColor=000000" height="28"></a>
  <a href="https://www.npmjs.com/package/vitamine-mcp"><img alt="npm" src="https://img.shields.io/npm/v/vitamine-mcp.svg?style=for-the-badge&labelColor=000000&color=0a0a0a" height="28"></a>
  <img alt="MCP" src="https://img.shields.io/badge/MCP-HTTP%20%2B%20stdio-0a0a0a.svg?style=for-the-badge&labelColor=000000" height="28">
</p>

Most browser automation tools spin up a fresh, empty Chromium. That's great for tests, and pretty useless when you want an agent to check your orders, poke around an admin dashboard, or reproduce a bug you're logged in to see. Vitamine goes the other way: a tiny Chrome extension plus a local Bun server that exposes your actual browser to Claude (or any MCP client).

```
Claude ──HTTP MCP──> bun server (127.0.0.1:9333) ──WebSocket──> extension ──chrome.debugger──> your tabs
```

## Why it's different

- **Your real session.** No separate profile, no re-logging in, no cookie juggling.
- **Scripts, not clicks.** Instead of one tool call per click, the agent sends a short async JS script that finds, clicks, waits, reads and loops in one go. Fewer round trips, fewer tokens.
- **Human-style targeting.** Point at things the way you would describe them: `page.click('Save')`, `page.fill('Email', 'a@b.c')`, `{ role: 'button', text: 'Download', near: 'Invoice #123' }`.
- **Stays out of your way.** Agent tabs open in the background, grouped under a "Vitamine" tab group, so you can keep working.
- **Network, console and cookies built in.** Inspect, replay and fetch requests with the page's own auth.
- **Reusable scripts.** Flows worth repeating get saved to `~/.vitamine/scripts/` and run by name.

## Installation

Requires [Bun](https://bun.sh) and a Chromium-based browser (Chrome, Vivaldi, Brave, Edge, Arc...).

```bash
bunx vitamine-mcp install
```

That one command:

1. Installs `vitamine-mcp` globally and starts the server at login (a LaunchAgent on macOS, a systemd user service on Linux).
2. Registers Vitamine with Claude Code and Claude Desktop, if you have them.
3. Opens a page in your browser that links the extension to the server.

### Install the extension

1. Install Vitamine from the Chrome Web Store *(listing coming soon)*, or load it unpacked from a checkout (see [Development](#development)).
2. On the extension's **Details** page, turn on **Allow User Scripts**. Fallback mode needs it (more on that below).
3. Run `vitamine-mcp pair` if you installed the extension after `install`. The toolbar badge says **ON** once it's linked, and clicking it shows the link status.

### The CLI

```bash
vitamine-mcp status        # server, autostart and extension at a glance
vitamine-mcp pair          # link the extension (again)
vitamine-mcp start | stop | restart
vitamine-mcp logs -f
vitamine-mcp rotate-token  # new token, restart, re-pair
vitamine-mcp uninstall     # removes autostart and client entries, keeps ~/.vitamine
```

### Connect other agents

`install` adds Vitamine to Claude Code and Claude Desktop as a stdio server (`vitamine-mcp mcp`), which reads the token from disk. Any other MCP client can either launch that command or talk HTTP to `http://127.0.0.1:9333/mcp` with `Authorization: Bearer $(cat ~/.vitamine/token)`.

### How pairing works

`~/.vitamine/token` (mode 600) is the one secret everything shares. MCP clients send it as a Bearer token, and the extension uses it to sign a mutual handshake with the server. The extension gets it once: `vitamine-mcp pair` opens `http://127.0.0.1:9333/pair#<token>`. The token sits in the URL fragment, which browsers never send to a server. The page passes it to the extension, which only keeps it after the running server proves it holds the same token. Only that local page can message the extension, so a website can't pair it with a token of its own.

## Quick start

Once it's connected, just ask your agent to do things in your browser. Under the hood it calls `run` with scripts like this:

```js
const p = await tabs.open('https://example.com/login'); // background tab
await p.fill('Email', 'a@b.c');                          // field labelled or next to "Email"
await p.click({ role: 'button', text: 'Continue' });     // waits for the page to settle
return p.snapshot();
```

Or something a bit meatier, like scraping results after an autocomplete:

```js
await page.pick('From', 'Nice', /NCE/);
await page.click('Search');
await page.waitFor(/results? found/i);
return (await page.readAll({ selector: '.result-card' }, { limit: 10 })).map(r => r.text);
```

## Tools

The MCP server exposes four tools:

| Tool           | What it does                                                              |
| -------------- | ------------------------------------------------------------------------- |
| `tabs`         | Lists every tab in every window. `*` marks the active one.                |
| `run`          | Runs an async JS script against a tab (the active one by default).        |
| `scripts_list` | Lists saved scripts.                                                      |
| `scripts_save` | Saves a reusable script to `~/.vitamine/scripts/<name>.js`.               |

Inside `run`, scripts get these globals: `page`, `tabs`, `net`, `cookies`, `logs`, `scripts`, `sleep`, `log` and `args`.

### Page

```js
page.goto(url)                          // also reload(), back(), forward()
page.info()                             // url, title, viewport, scroll
page.snapshot()                         // one line per visible control: 'e12 button "Save"'
page.snapshot({ diff: true })           // only what changed since the last snapshot
page.snapshot({ grep: /price/i })       // search controls across the whole page
page.read({ around: '£36' })            // text around each match, not the whole page
page.readAll({ selector: '.card' }, { where: /9\./ }) // text of every match, filtered
page.dismiss()                          // closes cookie banners, prefers "Reject"
page.click(spec)                        // waits for the DOM and navigation to settle
page.fill(spec, text)                   // clears and types
page.pick(field, text, option)          // autocomplete: type, then click the suggestion
page.type(text) / page.press('Enter')   // also select(), check(), hover(), scroll()
page.waitFor(spec) / page.waitForUrl(/checkout/)
page.eval(fn, ...args)                  // run a function in the page
page.screenshot({ full: true })         // works on background tabs too
page.fetch(url, init)                   // sent with the page's cookies
```

Actions wait up to 5s for their target and refuse to click covered elements. When nothing matches, the error lists the closest candidates so the agent can correct itself.

### Specs

A spec is how you point at an element:

```js
'Save'                                           // substring of the name (aria-label, label, placeholder, text)
/Total: \d+/                                     // a RegExp
{ role: 'button', text: 'Download', near: 'Invoice #123' }
{ text: 'Search', within: { selector: 'form' } }
{ text: 'Delete', nth: 2 }
ref('e12')                                       // a ref from a snapshot
```

### Tabs, network, cookies, logs

```js
tabs.list() / tabs.open(url) / tabs.get(id) / tabs.close(id)
net.capture({ reload: true })           // catch page-load requests too
net.list({ url: /api/, status: 500 })
net.body(id) / net.replay(id, { body })
cookies.get({ domain: 'example.com' })  // HttpOnly included
logs.list({ level: 'error' })
```

The full API reference lives in the `run` tool description in [server/tools.ts](server/tools.ts), which is exactly what the agent sees.

## Saved scripts

Anything you do more than twice can become a script. Ask the agent to save one, or drop a file into `~/.vitamine/scripts/`:

```js
// Headings and links of the current page. args: {limit?: number}
const limit = args.limit ?? 10;
const headings = (await page.findAll({ role: 'heading' }, { limit })).map(h => h.name);
return { url: (await page.info()).url, headings };
```

The first comment line becomes the description. Run it with `run({ script: 'page-outline', args: { limit: 5 } })` or `scripts.run('page-outline')` from another script.

## Privacy and safety

Vitamine has access to your real logged-in browser, so it's worth knowing what it does and doesn't do:

- The server only listens on `127.0.0.1` and rejects requests with any other `Host` header, which blocks DNS rebinding.
- `/mcp` needs the Bearer token from `~/.vitamine/token` (mode 600), so other programs and other users on the machine can't drive your browser.
- The extension only accepts a token from the local pair page, and only after the server proves it holds it.
- The extension socket only accepts the pinned extension ID, and both sides sign each other's random nonce with the token (HMAC-SHA256) before any command flows. Another extension can't impersonate Vitamine, and the extension won't obey some other process listening on port 9333.
- Scripts run in a separate JavaScript realm with no `Bun`, `process`, `require`, `fetch` or filesystem. They reach the browser only through the Vitamine globals, and anything they leave running is cut off when the run ends.
- Auth headers and cookie values are redacted in output unless a script explicitly asks with `reveal: true`.
- Other extensions' network traffic and console logs are hidden by default.
- The agent is told that page content is data, not instructions, and to confirm with you before sending, buying, posting or deleting anything. Still, keep an eye on what it's doing.

## Fallback mode

Chrome refuses to attach the debugger to pages where another extension (say, a password manager's inline menu) has a frame. When that happens, the tab switches to `page.mode = 'dom'` automatically and retries the debugger after 60 seconds. In fallback mode:

- Code runs in the page through `chrome.userScripts`, and input is synthetic (`isTrusted: false`).
- Navigation goes through `chrome.tabs`.
- Screenshots only work on the tab currently showing in its window, and there are no full-page shots.
- No network or console capture.
- Cookies come from `chrome.cookies` either way, so they work in both modes.

## Good to know

- Network and console capture start when Vitamine first touches a tab. Use `net.capture({ reload: true })` to catch page-load requests.
- Chrome shows a "started debugging this browser" bar while tabs are attached. Closing that bar detaches them.
- Only one extension can debug a tab at a time, so Claude in Chrome and Vitamine will fight over the same tab.
- v0.1 limits: main frame only (no iframes yet), and text search doesn't look inside shadow DOM.

## Development

```bash
git clone https://github.com/nitlix-studios/Vitamine
cd Vitamine
bun install
bun run build       # compiles extension/src into extension/dist
bun run dev         # server with reload on change
bun run watch       # rebuild the extension on change
bun run typecheck   # server, CLI and extension
bun cli/index.ts    # the CLI from the checkout (install, pair, status...)
```

Load the extension unpacked: open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and pick `extension/`. Then run `bun cli/index.ts pair`. The manifest pins the extension ID to `bmmhpjecmacoeiglmdeiiblgecgempil`, and the server only accepts the IDs in [server/paths.ts](server/paths.ts). If you build your own copy with a different `key`, set `VITAMINE_EXTENSION_ID` (comma-separated for several).

After rebuilding the extension, reload it without touching `chrome://extensions`:

```bash
curl -X POST localhost:9333/reload-extension -H "Authorization: Bearer $(cat ~/.vitamine/token)"
```

Environment overrides: `VITAMINE_PORT` (the extension's socket URL is fixed to `9333`, so change it there too), `VITAMINE_HOME` (defaults to `~/.vitamine`), `VITAMINE_TOKEN` / `VITAMINE_TOKEN_FILE`, `VITAMINE_SCRIPTS_DIR`.

## License

Apache-2.0. See [LICENSE](LICENSE).
