# DeepSeek Harness Desktop App

**中文** | [English](./README.en.md)

一个基于 **Electron** 的桌面应用，把 **DeepSeek Harness（`dsh`）** 官方 Web Shell 原生嵌入独立窗口，并在同一界面里提供 **Firefox 风格的多标签页** 与 **内置终端（WSL / 本机伪终端）**。

> 面向 Windows 设计（WSL 终端依赖 `wsl.exe`）；dsh 页面与本机连接在其它平台同样可用。

---

## 功能特性

### dsh Web Shell 原生集成
- 主进程启动 `dsh web`，并通过同源反向代理把 `/api/*`、`/plugins/*`、WebSocket 事件流转发进应用，官方 React Web Shell 以组件方式挂载（非 iframe / webview）。
- 聊天、工作区、会话、设置等全部沿用 dsh 官方界面，并与应用的外观设置联动。

### 多标签页（Firefox 风格）
- 两种标签页类型：
  - **dsh 页面**：嵌入的 Harness Web Shell。
  - **终端**：基于 xterm.js + node-pty 的伪终端。
- 标签页支持：拖拽排序、激活高亮（底部强调条）、悬停显示关闭按钮、中键关闭、标签过多时自动压缩 + 横向滚动。
- "+" 按钮弹出菜单选择新建类型；布局在应用重启后自动恢复。
- 同一文档内只能挂载一个 dsh Web Shell：在多个 dsh 标签页之间切换会重新引导；在终端与 dsh 之间来回切换不会刷新。

### 内置终端
- 渲染引擎：[xterm.js](https://xtermjs.org/)（含 `fit` / `web-links` 插件）；后端：`node-pty`。
- 连接类型：
  - **WSL**：通过 `wsl.exe -d <发行版>` 启动，自动检测已安装的发行版；Windows 路径自动用 `wslpath` 转换为 WSL 路径。
  - **本机 / PowerShell**：直接在本机运行默认 shell。
- 交互：选中即复制、`Ctrl+C` 复制（无选区时发送中断）、右键粘贴。
- 可配置：字体族、字号、光标样式（方块/下划线/竖线）、光标闪烁、回滚行数、配色方案（跟随应用强调色 / 经典 / 海洋 / 纸张）。

### 连接管理
| 类型 | 说明 |
|---|---|
| 本机 Local | 直接在当前系统运行 `dsh`（优先使用随应用捆绑的 `@deepseek-ai/dsh`，否则回退 PATH）。 |
| WSL | 通过 `wsl.exe -d <发行版>` 调用 WSL 内的 dsh。 |
| PowerShell | 通过 `powershell.exe` / `pwsh` 调用 dsh。 |

- 支持连接测试（执行 `dsh --version`）、默认连接、端口与启动/停止。

### 外观个性化
- 背景图片、背景透明度、背景遮罩、毛玻璃强度。
- 各模块独立透明度：标题栏、标签页栏、Harness 侧栏、面板、聊天区、设置抽屉、终端背景。
- DSH 界面可读性：设置面板、文本输入框的底色透明度。
- 强调色（同时作用于按钮、标签页高亮与终端配色）。
- 所有滑块采用统一的"标签 + 滑条 + 数值"行式布局。

### 健壮性
- **自动重启**：dsh 意外退出（非手动停止）时按指数退避自动拉起，5 分钟内最多 3 次；每次退出都会在命令台打印原因（如 `code=1` 内部错误、被信号终止等）。
- **会话日志修复**：对 dsh 会话 JSONL/zstd 日志的 seq 断裂做安全修复（先备份再重写）。
- 命令台可执行任意 `dsh` 子命令并实时显示输出。

---

## 技术栈

- [Electron](https://www.electronjs.org/) 31 + [electron-builder](https://www.electron.build/)（NSIS / 便携版）
- React 18 + Vite 5（渲染层）
- [@deepseek-ai/dsh](https://www.npmjs.com/package/@deepseek-ai/dsh)（随应用捆绑，`asarUnpack` 解包）
- [xterm.js](https://xtermjs.org/) + [node-pty](https://github.com/microsoft/node-pty)（终端）

---

## 环境要求

- **Node.js 18+**（建议 20+ / 22 LTS）。
- **dsh**：默认使用 `node_modules` 中捆绑的 `@deepseek-ai/dsh`；也可在连接里指定自定义 `dsh` 路径。
- **WSL 终端**：仅 Windows，且已安装 WSL 与至少一个发行版。
- `node-pty` 为原生模块，仓库已随附 Windows / Linux 预编译二进制；如需其它平台请自行构建。

---

## 快速开始

```bash
cd DeepSeekHarnessApp
npm install
npm start
```

`npm start` 会先用 Vite 构建渲染层（输出到 `dist/renderer-react`），再启动 Electron。

其它脚本：

```bash
npm run dev              # 以 --dev 模式启动
npm run build:renderer   # 仅构建渲染层
npm run pack             # 生成未打包目录（release/）
npm run dist             # 生成 NSIS 安装程序
npm run dist:portable    # 生成便携版
```

打包产物位于 `release/`，例如 `DeepSeek Harness-Setup-<version>.exe`。

---

## 项目结构

```text
DeepSeekHarnessApp/
├─ package.json
├─ vite.config.js             # 渲染层构建（把 @deepseek-ai/dsh-client-* 指向 vendor/ 源码）
├─ Image.ico                  # 应用图标
├─ vendor/                    # 构建时引用的 dsh 客户端组件源码（随仓库提交）
└─ src/
   ├─ main/
   │  ├─ main.js              # 主进程：窗口、同源代理、IPC、dsh/PTY 生命周期、自动重启
   │  ├─ dsh.js               # dsh 可执行解析与 local/WSL/PowerShell 启动
   │  ├─ pty.js               # node-pty 会话管理 + WSL 发行版检测 + wslpath
   │  └─ connections.js       # 连接与设置（含外观/终端/标签页）持久化
   ├─ preload.js              # contextBridge 安全暴露 IPC API
   └─ renderer-react/
      ├─ index.html           # React 入口
      ├─ main.jsx             # 应用主界面、标签页状态、设置抽屉、外观
      ├─ tabbar.jsx           # Firefox 风格标签栏 + 新建菜单
      ├─ terminal.jsx         # xterm 终端组件
      ├─ node-module-stub.js  # 浏览器端 node:module 占位（vite alias 用）
      └─ styles.css           # 样式（毛玻璃、标签页、终端、统一设置行）
```

---

## 标签页快捷键

| 快捷键 | 功能 |
|---|---|
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | 下一个 / 上一个标签页 |
| `Ctrl+1` ~ `Ctrl+9` | 跳转到第 N 个（`9` 为最后一个） |
| `Ctrl+T` | 新建 dsh 页面标签 |
| `Ctrl+Shift+T` | 新建终端标签 |
| `Ctrl+W` | 关闭当前标签页 |

---

## 数据与配置位置

- **连接 / 设置 / 外观 / 终端 / 标签页布局**：Electron `userData` 目录（`settings.json`、`connections.json`）。
- **dsh 会话与运行数据**：`~/.dsh`（或 `DSH_HOME` 指定的目录）。

---

## 注意事项

- `dsh web` 需要完整可用的 `@deepseek-ai/dsh` / `dsh` 环境（含其前端资源）。
- WSL2 通常会把 WSL 内监听的 `127.0.0.1` 端口自动转发到 Windows；若你的发行版/网络模式不支持，请改用 WSL IP 或自行配置端口转发。
- 如果 dsh 安装在 nvm 等用户 shell 环境中，可在连接里勾选"使用 WSL Shell 配置（bash -ic）"，或在"dsh 路径"中填写 WSL 内的绝对路径。
- 通过 `npm start` 启动时，应用会自动从传给 WSL 的 `PATH` 中剔除 `node_modules/.bin`，避免误用 Windows 侧的 dsh 脚本。
- dsh 需要较新的 Node.js；若 WSL 报 `node:util` 缺少 `parseEnv`，请在 WSL 中升级 Node（建议 20+）。
- 终端与 dsh 的复制粘贴经由主进程剪贴板桥接，窗口需处于可用状态。

---

## License

MIT
