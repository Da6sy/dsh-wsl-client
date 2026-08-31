# DeepSeek Harness Desktop App

[中文](./README.md) | **English**

An **Electron** desktop application that embeds the official **DeepSeek Harness (`dsh`)** Web Shell natively in a standalone window, and adds **Firefox-style multi-tabs** plus a **built-in terminal (WSL / local pseudo-terminal)** in the same interface.

> Designed for Windows (the WSL terminal relies on `wsl.exe`); the dsh page and local connections also work on other platforms.

---

## Features

### Native dsh Web Shell integration
- The main process launches `dsh web` and reverse-proxies `/api/*`, `/plugins/*` and the WebSocket event streams into the app over the same origin, mounting the official React Web Shell as a component (not an iframe / webview).
- Chat, workspaces, sessions and settings all use the official dsh UI and follow the app's appearance settings.

### Multi-tabs (Firefox-style)
- Two tab types:
  - **dsh page**: the embedded Harness Web Shell.
  - **Terminal**: a pseudo-terminal based on xterm.js + node-pty.
- Tabs support drag-to-reorder, active highlight (bottom accent bar), hover-revealed close button, middle-click close, and automatic compression + horizontal scrolling when there are many tabs.
- A "+" button opens a menu to pick the new tab type; the layout is restored across restarts.
- Only one dsh Web Shell can be mounted per document: switching between multiple dsh tabs re-boots it; switching between a terminal and a dsh tab does not refresh it.

### Built-in terminal
- Renderer: [xterm.js](https://xtermjs.org/) (with `fit` / `web-links` addons); backend: `node-pty`.
- Connection types:
  - **WSL**: launched via `wsl.exe -d <distro>`, auto-detecting installed distros; Windows paths are converted to WSL paths with `wslpath`.
  - **Local / PowerShell**: runs the default shell on the host.
- Interactions: copy-on-select, `Ctrl+C` copies (sends an interrupt when nothing is selected), right-click paste.
- Configurable: font family, font size, cursor style (block/underline/bar), cursor blink, scrollback lines, color scheme (follow app accent / classic / ocean / paper).

### Connection management
| Type | Description |
|---|---|
| Local | Runs `dsh` on the current system (prefers the bundled `@deepseek-ai/dsh`, falls back to PATH). |
| WSL | Invokes dsh inside WSL via `wsl.exe -d <distro>`. |
| PowerShell | Invokes dsh via `powershell.exe` / `pwsh`. |

- Supports connection testing (runs `dsh --version`), default connection, port, and start/stop.

### Appearance personalization
- Background image, background opacity, background overlay, glass blur strength.
- Per-module opacity: titlebar, tab strip, Harness sidebar, panel, chat area, settings drawer, terminal background.
- DSH UI readability: background opacity for the settings panel and the text input box.
- Accent color (also drives buttons, tab highlight and terminal coloring).
- All sliders share a unified "label + slider + value" row layout.

### Robustness
- **Auto-restart**: when dsh dies without an explicit stop, it is relaunched with exponential backoff, capped at 3 times within 5 minutes; every exit prints its reason in the console panel (e.g. `code=1` internal error, killed by signal, etc.).
- **Session log repair**: safely repairs seq gaps in dsh session JSONL/zstd logs (backs up before rewriting).
- The command console can run any `dsh` subcommand with live output.

---

## Tech stack

- [Electron](https://www.electronjs.org/) 31 + [electron-builder](https://www.electron.build/) (NSIS / portable)
- React 18 + Vite 5 (renderer)
- [@deepseek-ai/dsh](https://www.npmjs.com/package/@deepseek-ai/dsh) (bundled with the app, `asarUnpack`ed)
- [xterm.js](https://xtermjs.org/) + [node-pty](https://github.com/microsoft/node-pty) (terminal)

---

## Requirements

- **Node.js 18+** (20+ / 22 LTS recommended).
- **dsh**: uses the bundled `@deepseek-ai/dsh` in `node_modules` by default; you can also point a connection at a custom `dsh` path.
- **WSL terminal**: Windows only, with WSL and at least one distro installed.
- `node-pty` is a native module; Windows / Linux prebuilt binaries are included. Build it yourself for other platforms.

---

## Getting started

```bash
cd DeepSeekHarnessApp
npm install
npm start
```

`npm start` first builds the renderer with Vite (into `dist/renderer-react`), then launches Electron.

Other scripts:

```bash
npm run dev              # start with --dev
npm run build:renderer   # build the renderer only
npm run pack             # produce an unpacked directory (release/)
npm run dist             # produce an NSIS installer
npm run dist:portable    # produce a portable build
```

Build artifacts land in `release/`, e.g. `DeepSeek Harness-Setup-<version>.exe`.

---

## Project structure

```text
DeepSeekHarnessApp/
├─ package.json
├─ vite.config.js             # renderer build (maps @deepseek-ai/dsh-client-* to vendor/ sources)
├─ Image.ico                  # app icon
├─ vendor/                    # dsh client component sources referenced at build time (committed)
└─ src/
   ├─ main/
   │  ├─ main.js              # main process: window, same-origin proxy, IPC, dsh/PTY lifecycle, auto-restart
   │  ├─ dsh.js               # dsh resolution and local/WSL/PowerShell launch
   │  ├─ pty.js               # node-pty sessions + WSL distro detection + wslpath
   │  └─ connections.js       # connections & settings (appearance/terminal/tabs) persistence
   ├─ preload.js              # contextBridge-safe IPC API
   └─ renderer-react/
      ├─ index.html           # React entry
      ├─ main.jsx             # app shell, tab state, settings drawer, appearance
      ├─ tabbar.jsx           # Firefox-style tab strip + new-tab menu
      ├─ terminal.jsx         # xterm terminal component
      ├─ node-module-stub.js  # browser-side node:module stub (used by the vite alias)
      └─ styles.css           # styles (glass, tabs, terminal, unified setting rows)
```

---

## Tab shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Next / previous tab |
| `Ctrl+1` ~ `Ctrl+9` | Jump to the Nth tab (`9` = last) |
| `Ctrl+T` | New dsh page tab |
| `Ctrl+Shift+T` | New terminal tab |
| `Ctrl+W` | Close the current tab |

---

## Data & config locations

- **Connections / settings / appearance / terminal / tab layout**: Electron `userData` directory (`settings.json`, `connections.json`).
- **dsh sessions & runtime data**: `~/.dsh` (or the directory set by `DSH_HOME`).

---

## Notes

- `dsh web` needs a fully working `@deepseek-ai/dsh` / `dsh` environment (including its frontend assets).
- WSL2 usually forwards ports listened on `127.0.0.1` inside WSL to Windows; if your distro / network mode does not, use the WSL IP or set up port forwarding yourself.
- If dsh is installed under a user shell environment such as nvm, enable "use WSL shell config (bash -ic)" in the connection, or fill in the absolute path inside WSL for "dsh path".
- When launched via `npm start`, the app strips `node_modules/.bin` from the `PATH` passed to WSL, so it does not accidentally use the Windows-side dsh shim.
- dsh needs a recent Node.js; if WSL reports that `node:util` is missing `parseEnv`, upgrade Node inside WSL (20+ recommended).
- Terminal and dsh copy/paste go through a main-process clipboard bridge; the window must be usable.

---

## License

MIT
