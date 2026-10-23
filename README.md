# Vitamine

Let your AI agent drive your real browser. Your tabs, your cookies, your logins.

<p>
  <a href="https://github.com/nitlix-studios/Vitamine/blob/main/LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/github/license/nitlix-studios/Vitamine.svg?style=for-the-badge&labelColor=000000" height="28"></a>
  <img alt="Version 0.1.0" src="https://img.shields.io/badge/version-0.1.0-0a0a0a.svg?style=for-the-badge&labelColor=000000" height="28">
  <img alt="MCP" src="https://img.shields.io/badge/MCP-HTTP-0a0a0a.svg?style=for-the-badge&labelColor=000000" height="28">
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
- **Reusable scripts.** Flows worth repeating get saved to `scripts/` and run by name.

## Installation

Requires [Bun](https://bun.sh) and a Chromium-based browser (Chrome, Vivaldi, Brave, Edge, Arc...).

```bash
git clone https://github.com/nitlix-studios/Vitamine
cd Vitamine
bun install
bun run build   # compiles extension/src into extension/dist
bun run start   # or `bun run dev` to reload on change
```

### Load the extension

1. Open `chrome://extensions` (or `vivaldi://extensions`, etc.) and turn on **Developer mode**.
2. Click **Load unpacked** and pick the `extension/` folder.
3. On the extension's **Details** page, turn on **Allow User Scripts**. Fallback mode needs it (more on that below).
4. The toolbar badge says **ON** once it's connected to the server.

### Connect your agent

For Claude Code:

```bash
claude mcp add --transport http --scope user vitamine http://127.0.0.1:9333/mcp
```

Any other MCP client works too, just point it at `http://127.0.0.1:9333/mcp` over HTTP.

Quick sanity check:

```bash
curl localhost:9333/health
```

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
| `scripts_save` | Saves a reusable script to `scripts/<name>.js`.                           |

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

Anything you do more than twice can become a script. Ask the agent to save one, or drop a file into `scripts/`:

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
- The extension socket only accepts connections from `chrome-extension://` origins.
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
bun run dev         # server with reload on change
bun run watch       # rebuild the extension on change
bun run typecheck   # server and extension
```

After rebuilding the extension, reload it without touching `chrome://extensions`:

```bash
curl -X POST localhost:9333/reload-extension
```

Set `VITAMINE_PORT` to run the server on something other than `9333` (you'll need to update the extension's socket URL to match).

## License

Apache-2.0. See [LICENSE](LICENSE).
