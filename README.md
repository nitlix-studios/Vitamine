# Vitamine

Drive your real browser (your tabs, your cookies) from Claude over MCP.

```
Claude ──HTTP MCP──> bun server (127.0.0.1:9333) ──WebSocket──> extension ──chrome.debugger──> your tabs
```

## Setup

```bash
bun install
bun run build      # compiles extension/src → extension/dist
bun run dev        # server with reload on change
```

1. Open `chrome://extensions` (or `vivaldi://extensions`), turn on Developer mode, choose **Load unpacked**, and pick the `extension/` folder.
2. On the extension's **Details** page, turn on **Allow User Scripts**. Fallback mode needs it.
3. The toolbar badge shows **ON** once it's connected to the server.
4. Register the server with Claude Code:

```bash
claude mcp add --transport http --scope user vitamine http://127.0.0.1:9333/mcp
```

After changing `extension/src`, run `bun run build`, then `curl -X POST localhost:9333/reload-extension` (or click reload on the extension card).

## Tools

- `tabs`: every tab in every window.
- `run`: an async JS script with `page`, `tabs`, `net`, `cookies`, `logs`, `scripts`, `sleep`, `log` and `args`. The full API is in the tool description ([server/tools.ts](server/tools.ts)).
- `scripts_save` / `scripts_list`: reusable scripts in [scripts/](scripts).

## Notes

- Network and console capture start when Vitamine first touches a tab. Use `net.capture({reload:true})` to catch page-load requests.
- Auth headers and cookie values are hidden in output unless `reveal:true`.
- Chrome shows a "started debugging this browser" bar while tabs are attached. Closing that bar detaches the tabs.
- Only one extension can debug a tab at a time, so Claude in Chrome and Vitamine conflict on the same tab.
- **Fallback mode:** Chrome refuses the debugger on pages where another extension (e.g. 1Password's inline menu) has a frame. Such a tab switches to `page.mode = "dom"` by itself and retries the debugger after 60s. In fallback mode:
  - Code runs in the page through `chrome.userScripts`, and input is synthetic (`isTrusted: false`).
  - Navigation uses `chrome.tabs`.
  - Screenshots only work on the tab showing in its window, and there are no full-page shots.
  - There's no network or console capture.
  - Cookies always come from `chrome.cookies`, so they work in both modes.
- v0.1 limits: main frame only (no iframes), and text search doesn't look inside shadow DOM.
