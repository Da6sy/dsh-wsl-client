'use strict';

const { app, BrowserWindow, ipcMain, shell, clipboard, Menu } = require('electron');
const path = require('node:path');
const http = require('node:http');
const fs = require('node:fs');
const { spawnDsh, runDshCaptured } = require('./dsh');
const { Store, testConnection } = require('./connections');
const { PtyManager } = require('./pty');

let mainWindow = null;
let store = null;
const ptyManager = new PtyManager();

// A proxied connection (renderer <-> dsh web server) can reset mid-stream
// during normal shutdown/restart races. Every known stream carries its own
// error handler; this net catches the residue so a transient reset can no
// longer surface as "A JavaScript error occurred in the main process".
// Anything that is NOT a connection-teardown error is rethrown untouched.
const NETWORK_TEARDOWN_CODES = new Set([
  'ECONNRESET', 'EPIPE', 'ECONNABORTED', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN',
]);
process.on('uncaughtException', (error) => {
  if (error && NETWORK_TEARDOWN_CODES.has(error.code)) {
    console.error(`[dsh-app] suppressed network teardown error (${error.code}): ${error.message}`);
    return;
  }
  throw error;
});

// Keep Chromium on its normal hardware-accelerated path. These switches improve
// raster and texture upload on supported Windows GPUs without disabling fallback.
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
// Avoid disk-cache permission errors on locked-down Windows profiles.
app.commandLine.appendSwitch('disk-cache-size', '0');
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
app.commandLine.appendSwitch('disable-gpu-program-cache');

const runningProcesses = new Map();
let rendererServer = null;
let processSequence = 0;

function getWebBase() {
  const entry = getWebEntry();
  return entry?.url ? String(entry.url).replace(/\/+$/, '') : null;
}

function startRendererServer() {
  return new Promise((resolve, reject) => {
    const dist = path.join(__dirname, '..', '..', 'dist', 'renderer-react');
    const mime = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript',
      '.css': 'text/css',
      '.svg': 'image/svg+xml',
      '.woff': 'font/woff',
      '.woff2': 'font/woff2',
      '.ttf': 'font/ttf',
      '.png': 'image/png',
      '.json': 'application/json',
    };
    const server = http.createServer((req, res) => {
      // The renderer may abort any request (navigation, tab switches, reload
      // storms). An aborted socket turns the next write into an 'error' event
      // that would otherwise crash the main process; nothing to do but drop it.
      res.on('error', () => {});
      const requestUrl = new URL(req.url || '/', 'http://127.0.0.1');
      const pathname = requestUrl.pathname;
      // Proxy dsh API/plugin traffic through the same origin so the official
      // web shell can run without CORS or file:// origin problems.
      if (
        pathname.startsWith('/api/')
        || pathname.startsWith('/plugins/')
        || pathname.startsWith('/dsh-')
        || pathname.startsWith('/events')
        || pathname === '/session.export'
      ) {
        const base = getWebBase();
        if (!base) {
          res.writeHead(502, { 'content-type': 'text/plain' });
          res.end('dsh server not running');
          return;
        }
        const proxyUrl = new URL(pathname + requestUrl.search, base);
        const headers = { ...req.headers, host: proxyUrl.host };
        // The browser sees the local renderer origin, not the dsh origin.
        // Remove browser-origin markers so the dsh loopback trust fence accepts
        // the proxied request.
        delete headers.origin;
        delete headers['sec-fetch-site'];
        delete headers['sec-fetch-mode'];
        delete headers['sec-fetch-dest'];
        const proxyReq = http.request(proxyUrl, {
          method: req.method,
          headers,
        }, (proxyRes) => {
          // A killed dsh server resets in-flight responses; the renderer may
          // abort in-flight requests. Every stream needs an error handler or
          // the reset surfaces as an uncaught ECONNRESET in the main process.
          proxyRes.on('error', () => {
            if (!res.writableEnded) try { res.end(); } catch (_) { /* already gone */ }
          });
          res.on('error', () => {
            proxyRes.destroy();
            proxyReq.destroy();
          });
          try {
            res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
            proxyRes.pipe(res);
          } catch (_) {
            proxyRes.destroy();
          }
        });
        proxyReq.on('error', () => {
          if (!res.headersSent && !res.writableEnded) {
            try {
              res.writeHead(502, { 'content-type': 'text/plain' });
              res.end('proxy error');
            } catch (_) { /* client already gone */ }
          } else if (!res.writableEnded) {
            try { res.end(); } catch (_) { /* client already gone */ }
          }
        });
        req.on('error', () => proxyReq.destroy());
        req.pipe(proxyReq);
        return;
      }

      const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
      const filePath = path.resolve(dist, relative);
      if (!filePath.startsWith(path.resolve(dist))) {
        res.writeHead(403);
        res.end('forbidden');
        return;
      }
      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end('not found');
          return;
        }
        res.writeHead(200, { 'content-type': mime[path.extname(filePath)] || 'application/octet-stream' });
        res.end(data);
      });
    });
    // The official dsh web shell uses WebSocket for its live event streams
    // (/api/events.mux, /api/events.host). The renderer server must forward
    // upgrade requests to the running dsh server as well; otherwise the shell
    // silently falls back to history polling and new messages only appear late.
    server.on('upgrade', (req, socket, head) => {
      const requestUrl = new URL(req.url || '/', 'http://127.0.0.1');
      const pathname = requestUrl.pathname;
      if (!pathname.startsWith('/api/') && !pathname.startsWith('/plugins/') && !pathname.startsWith('/dsh-')) {
        socket.destroy();
        return;
      }
      const base = getWebBase();
      if (!base) {
        socket.destroy();
        return;
      }
      const proxyUrl = new URL(pathname + requestUrl.search, base);
      const headers = { ...req.headers, host: proxyUrl.host };
      delete headers.origin;
      delete headers['sec-fetch-site'];
      delete headers['sec-fetch-mode'];
      delete headers['sec-fetch-dest'];
      const proxyReq = http.request({
        protocol: proxyUrl.protocol === 'https:' ? 'https:' : 'http:',
        hostname: proxyUrl.hostname,
        port: proxyUrl.port || undefined,
        path: proxyUrl.pathname + proxyUrl.search,
        method: req.method || 'GET',
        headers: {
          ...headers,
          connection: 'Upgrade',
          upgrade: 'websocket',
        },
      });
      proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
        const lines = ['HTTP/1.1 101 Switching Protocols'];
        for (const [key, value] of Object.entries(proxyRes.headers || {})) {
          if (Array.isArray(value)) {
            for (const item of value) lines.push(`${key}: ${item}`);
          } else {
            lines.push(`${key}: ${value}`);
          }
        }
        // Either side of a proxied WebSocket can reset first (renderer reload,
        // dsh shutdown). Both sockets need error handlers and cross-teardown,
        // or the reset escapes as an uncaught ECONNRESET.
        const teardown = () => {
          socket.destroy();
          proxySocket.destroy();
        };
        socket.on('error', teardown);
        proxySocket.on('error', teardown);
        try {
          socket.write(lines.join('\r\n') + '\r\n\r\n');
          if (proxyHead && proxyHead.length) socket.write(proxyHead);
          if (head && head.length) proxySocket.write(head);
        } catch (_) {
          teardown();
          return;
        }
        proxySocket.pipe(socket);
        socket.pipe(proxySocket);
      });
      proxyReq.on('response', () => socket.destroy());
      proxyReq.on('error', () => socket.destroy());
      socket.on('error', () => socket.destroy());
      proxyReq.end();
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      rendererServer = server;
      resolve(server.address().port);
    });
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1380,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: 'DeepSeek Harness',
    icon: path.join(app.getAppPath(), 'Image.ico'),
    backgroundColor: '#0b0e14',
    autoHideMenuBar: true,
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // The React web-shell renderer is the only UI. Serve it from the local
  // renderer server so the official dsh shell can share the same origin.
  startRendererServer()
    .then((port) => mainWindow?.loadURL(`http://127.0.0.1:${port}/`))
    .catch((err) => {
      console.error('Failed to start renderer server', err);
    });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('maximize', () => {
    mainWindow?.webContents.send('window:maximized-change', true);
  });
  mainWindow.on('unmaximize', () => {
    mainWindow?.webContents.send('window:maximized-change', false);
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function killProcessTree(child) {
  if (!child || child.pid === undefined) return;
  try {
    if (process.platform === 'win32') {
      const { spawnSync } = require('node:child_process');
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
      });
    } else {
      child.kill('SIGTERM');
      // Give it a short grace period, then SIGKILL.
      setTimeout(() => {
        if (child.exitCode === null && !child.killed) {
          child.kill('SIGKILL');
        }
      }, 3000).unref();
    }
  } catch (_) {
    try {
      child.kill();
    } catch (_) {
      // already gone
    }
  }
}

function attachProcessEvents(id, child, sender) {
  const emit = (channel, payload) => {
    if (sender && !sender.isDestroyed()) {
      sender.send(channel, payload);
    }
  };

  child.stdout?.on('data', (chunk) => {
    emit('dsh:output', { id, stream: 'stdout', text: chunk.toString() });
  });
  child.stderr?.on('data', (chunk) => {
    emit('dsh:output', { id, stream: 'stderr', text: chunk.toString() });
  });
  child.on('error', (err) => {
    emit('dsh:exit', { id, code: -1, signal: null, error: err.message });
    runningProcesses.delete(id);
  });
  child.on('close', (code, signal) => {
    emit('dsh:exit', { id, code, signal });
    runningProcesses.delete(id);
  });
}

function getActiveConnection(settings) {
  const connections = store.getConnections();
  const activeId = settings.activeConnectionId || 'local-default';
  return connections.find((c) => c.id === activeId) || connections[0] || { type: 'local' };
}

function getWebEntry() {
  return Array.from(runningProcesses.values()).find((p) => p.kind === 'web' && p.url) || null;
}

// `--no-open` only exists from dsh 0.1.0-rc.8 onward. Injecting it into an
// older dsh makes commander reject the whole invocation (exit code 1), so we
// must only pass it when the target dsh actually supports it. The result is
// probed once per connection (via `dsh web --help`) and cached.
const noOpenSupportCache = new Map();

function noOpenCacheKey(connection) {
  return [
    connection?.id,
    connection?.type,
    connection?.dshPath || '',
    connection?.wslDistro || '',
  ].join('|');
}

async function supportsNoOpen(connection) {
  // Only WSL invocations get the flag; local/PowerShell never do.
  if (connection?.type !== 'wsl') return false;
  const key = noOpenCacheKey(connection);
  const cached = noOpenSupportCache.get(key);
  if (cached !== undefined) return cached;
  let supported = false;
  try {
    const result = await runDshCaptured(connection, ['web', '--help']);
    const text = `${result.stdout || ''}\n${result.stderr || ''}`;
    supported = text.includes('--no-open');
    noOpenSupportCache.set(key, supported);
  } catch (_) {
    // Spawn failed (dsh unreachable); fall back to not injecting the flag and
    // leave the cache empty so we probe again next time.
    supported = false;
  }
  return supported;
}

async function suppressDshWebOpen(args, connection) {
  const normalized = Array.isArray(args) ? args.map(String) : [];
  if (connection?.type !== 'wsl') return normalized;
  const isWebAlias = normalized[0] === 'web';
  const profileIndex = normalized.indexOf('--profile');
  const isWebProfile = profileIndex >= 0 && normalized[profileIndex + 1] === 'web';
  if (!isWebAlias && !isWebProfile) return normalized;
  if (normalized.includes('--no-open')) return normalized;
  if (!(await supportsNoOpen(connection))) return normalized;
  return [...normalized, '--no-open'];
}



ipcMain.handle('connections:list', () => store.getConnections());

ipcMain.handle('connections:save', (_event, connections) => {
  return store.saveConnections(connections);
});

ipcMain.handle('connections:test', async (_event, connection) => {
  return testConnection(connection);
});

ipcMain.handle('settings:get', () => store.getSettings());

ipcMain.handle('settings:set', (_event, settings) => store.saveSettings(settings));

// Custom window controls
ipcMain.on('window:minimize', () => {
  mainWindow?.minimize();
});
ipcMain.on('window:close', () => {
  mainWindow?.close();
});
ipcMain.handle('window:toggle-maximize', () => {
  if (!mainWindow) return false;
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow.maximize();
  }
  return mainWindow.isMaximized();
});
ipcMain.handle('window:is-maximized', () => mainWindow?.isMaximized() ?? false);

ipcMain.handle('dsh:run', async (event, payload) => {
  const settings = store.getSettings();
  const connectionId = payload.connectionId || settings.activeConnectionId;
  const connections = store.getConnections();
  const connection = connections.find((c) => c.id === connectionId) || getActiveConnection(settings);
  const args = await suppressDshWebOpen(payload.args, connection);
  const id = `run-${++processSequence}`;

  try {
    const child = spawnDsh(connection, args, {
      cwd: payload.cwd || settings.defaultCwd || undefined,
      env: payload.env || undefined,
    });
    runningProcesses.set(id, { child, connectionId });
    attachProcessEvents(id, child, event.sender);
    return { ok: true, id, pid: child.pid };
  } catch (err) {
    return { ok: false, id, error: err.message };
  }
});

ipcMain.handle('dsh:stop', (_event, id) => {
  const entry = runningProcesses.get(id);
  if (!entry) return { ok: false, error: 'process not found' };
  killProcessTree(entry.child);
  return { ok: true };
});

// ---- dsh web lifecycle: diagnostics + guarded auto-restart ----
//
// dsh can die without user action (an unhandled rejection inside the dsh
// process trips its fail-loud exit, the WSL VM can hiccup, the machine can
// sleep). Previously the exit code was dropped on the floor and the user was
// left with a dead "未运行" badge. Now every exit is described, logged to the
// console panel, and — unless the user stopped it — automatically restarted
// with backoff, capped so a crash loop cannot spin forever.

let appQuitting = false;
let lastWebExit = null;
const webRestart = { attempts: [], timer: null };
const WEB_RESTART_MAX = 3;
const WEB_RESTART_WINDOW_MS = 5 * 60 * 1000;

function describeWebExit(code, signal) {
  if (signal === 'SIGKILL' || signal === 'SIGTERM') return `被信号强制终止（${signal}）`;
  if (code === 0) return '正常退出';
  // 0xC000013A = STATUS_CONTROL_C_EXIT on Windows.
  if (code === 3221225786) return '被 Ctrl+C / 系统中止信号终止';
  if (code === 1) return '内部错误退出（code=1，常见于 dsh 内部未处理的异常，详见上方日志）';
  return `异常退出（code=${code}${signal ? `, signal=${signal}` : ''}）`;
}

function webEventSender(sender) {
  if (sender && !sender.isDestroyed()) return sender;
  const fallback = mainWindow?.webContents;
  return fallback && !fallback.isDestroyed() ? fallback : null;
}

function scheduleWebAutoRestart(launchPayload, sender) {
  const now = Date.now();
  webRestart.attempts = webRestart.attempts.filter((time) => now - time < WEB_RESTART_WINDOW_MS);
  const emitTo = () => webEventSender(sender);
  if (webRestart.attempts.length >= WEB_RESTART_MAX) {
    const target = emitTo();
    target?.send('dsh:web:restart-failed', {
      error: `5 分钟内已自动重启 ${WEB_RESTART_MAX} 次，已停止自动重启。请检查日志后手动启动。`,
    });
    return;
  }
  const delay = Math.min(8000, 1000 * (2 ** webRestart.attempts.length));
  webRestart.attempts.push(now);
  webRestart.timer = setTimeout(() => {
    webRestart.timer = null;
    if (appQuitting) return;
    emitTo()?.send('dsh:web:restarting', { delay });
    emitTo()?.send('dsh:output', { id: 'auto-restart', stream: 'stderr', text: `[Harness] 正在自动重启 dsh（${Math.round(delay / 1000)}s 后）…\n` });
    launchWebServer(launchPayload, sender).catch(() => {});
  }, delay);
  webRestart.timer.unref?.();
}

async function launchWebServer(payload = {}, sender) {
  // If a web server is already running (or starting), reuse it.
  const existing = Array.from(runningProcesses.values()).find((p) => p.kind === 'web');
  if (existing) {
    if (existing.url) {
      return { ok: true, id: existing.id, url: existing.url, alreadyRunning: true };
    }
    return existing.readyPromise
      .then((url) => ({ ok: true, id: existing.id, url, alreadyRunning: true }))
      .catch((error) => ({ ok: false, id: existing.id, error: error.message, alreadyRunning: true }));
  }

  const settings = store.getSettings();
  const connectionId = payload.connectionId || settings.activeConnectionId;
  const connections = store.getConnections();
  const connection = connections.find((c) => c.id === connectionId) || getActiveConnection(settings);

  // A fresh (manual or auto) launch supersedes any pending auto-restart tick,
  // so two spawns cannot race for the same port.
  if (webRestart.timer) {
    clearTimeout(webRestart.timer);
    webRestart.timer = null;
  }

  const host = payload.host || '127.0.0.1';
  const port = payload.port !== undefined ? payload.port : settings.webPort || 0;
  const args = ['web'];
  // Only pass --no-open when this connection's dsh supports it; older dsh
  // rejects the unknown flag and exits with code 1.
  if (await supportsNoOpen(connection)) args.push('--no-open');
  args.push('--host', host, '--port', String(port));
  const trustedHosts = Array.isArray(payload.trustedHosts) ? payload.trustedHosts : [];
  for (const trusted of trustedHosts) {
    args.push('--trusted-host', trusted);
  }
  const id = `web-${++processSequence}`;
  try {
    const child = spawnDsh(connection, args, {
      cwd: payload.cwd || settings.defaultCwd || undefined,
    });
    let resolveReady;
    let rejectReady;
    const readyPromise = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    // Do not leave the IPC caller waiting forever if dsh cannot boot. WSL
    // cold starts (VM boot + login shell) can be slow; give them 30s.
    const readyTimeout = setTimeout(() => {
      rejectReady(new Error('等待 dsh web 服务地址超时，请检查 WSL 中的 dsh、Node.js 和端口转发'));
    }, 30000);
    readyTimeout.unref();
    const entry = {
      child,
      connectionId,
      kind: 'web',
      id,
      url: null,
      readyPromise,
      userStopped: false,
      launchPayload: {
        connectionId,
        host,
        port,
        cwd: payload.cwd || settings.defaultCwd || undefined,
        trustedHosts,
      },
    };
    runningProcesses.set(id, entry);

    const emit = (channel, data) => {
      webEventSender(sender)?.send(channel, data);
    };

    let buffer = '';
    const parseUrl = (text) => {
      // WSL shells and dsh plugins may decorate output with ANSI escape codes.
      buffer = (buffer + text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')).slice(-8192);
      const match = buffer.match(/https?:\/\/[^\s]+/);
      if (match) {
        const url = match[0].replace(/[),.;]+$/, '');
        const isLoopback = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(?:\/|$)/.test(url);
        if (!entry.url || isLoopback) {
          entry.url = url;
          clearTimeout(readyTimeout);
          // A healthy start resets the auto-restart budget.
          webRestart.attempts = [];
          resolveReady(url);
          emit('dsh:web:url', { id, url });
        }
      }
    };
    child.stdout?.on('data', (chunk) => {
      const text = chunk.toString();
      parseUrl(text);
      emit('dsh:output', { id, stream: 'stdout', text });
    });
    child.stderr?.on('data', (chunk) => {
      const text = chunk.toString();
      parseUrl(text);
      emit('dsh:output', { id, stream: 'stderr', text });
    });
    child.on('error', (err) => {
      clearTimeout(readyTimeout);
      rejectReady(err);
      lastWebExit = { id, error: err.message, time: Date.now() };
      emit('dsh:web:exit', { id, error: err.message, userStopped: entry.userStopped, willRestart: false, reason: err.message });
      runningProcesses.delete(id);
    });
    child.on('close', (code, signal) => {
      clearTimeout(readyTimeout);
      if (!entry.url) {
        rejectReady(new Error(`dsh web 未能启动 (code=${code}, signal=${signal || 'none'})`));
      }
      const reason = describeWebExit(code, signal);
      lastWebExit = { id, code, signal, reason, time: Date.now() };
      const willRestart = !entry.userStopped
        && !appQuitting
        && store.getSettings().autoRestart !== false;
      emit('dsh:web:exit', { id, code, signal, userStopped: entry.userStopped, willRestart, reason });
      emit('dsh:output', {
        id,
        stream: 'stderr',
        text: `\n[Harness] dsh 进程退出：${reason}${willRestart ? '，即将自动重启…' : ''}\n`,
      });
      runningProcesses.delete(id);
      if (willRestart) scheduleWebAutoRestart(entry.launchPayload, sender);
    });

    return readyPromise
      .then((url) => ({ ok: true, id, pid: child.pid, url }))
      .catch((error) => {
        // A timeout means dsh may still be alive without a usable web server.
        // Remove it from the reuse set and stop it before allowing a retry.
        if (runningProcesses.get(id) === entry) {
          entry.userStopped = true;
          runningProcesses.delete(id);
          if (child.exitCode === null) killProcessTree(child);
        }
        return { ok: false, id, pid: child.pid, error: error.message };
      });
  } catch (err) {
    return { ok: false, id, error: err.message };
  }
}

ipcMain.handle('dsh:web:start', (event, payload = {}) => launchWebServer(payload, event.sender));

ipcMain.handle('dsh:web:stop', () => {
  // Explicit user stop: cancel any pending auto-restart and mark the entries
  // so their close handlers do not relaunch.
  if (webRestart.timer) {
    clearTimeout(webRestart.timer);
    webRestart.timer = null;
  }
  webRestart.attempts = [];
  const entries = Array.from(runningProcesses.values()).filter((p) => p.kind === 'web');
  for (const entry of entries) {
    entry.userStopped = true;
    killProcessTree(entry.child);
  }
  return { ok: true, stopped: entries.length };
});

ipcMain.handle('dsh:web:status', () => {
  const existing = Array.from(runningProcesses.values()).find((p) => p.kind === 'web');
  return { running: Boolean(existing), url: existing?.url || null, id: existing?.id || null, lastExit: lastWebExit };
});

ipcMain.handle('http:fetch-text', async (_event, url) => {
  try {
    const response = await fetch(url);
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
    return { ok: true, text: await response.text() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('dialog:select-image', async () => {
  const { canceled, filePaths } = await require('electron').dialog.showOpenDialog(mainWindow, {
    title: '选择背景图片',
    filters: [
      { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] },
    ],
    properties: ['openFile'],
  });
  if (canceled || filePaths.length === 0) return { canceled: true };
  const filePath = filePaths[0];
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const mime = ext === 'jpg' ? 'jpeg' : ext;
  const data = fs.readFileSync(filePath);
  return {
    canceled: false,
    path: filePath,
    dataUrl: `data:image/${mime};base64,${data.toString('base64')}`,
  };
});

// ---- Terminal (PTY) IPC ----
// createPty returns a session id; output is streamed back on pty:data keyed
// by that id so multiple terminal tabs can run concurrently.
ipcMain.handle('pty:create', (event, options = {}) => {
  try {
    const emit = (channel, payload) => {
      if (event.sender && !event.sender.isDestroyed()) {
        event.sender.send(channel, payload);
      }
    };
    const { id, pid } = ptyManager.create(options, emit);
    return { ok: true, id, pid };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('pty:resize', (_event, { id, cols, rows } = {}) => {
  ptyManager.resize(id, cols, rows);
  return { ok: true };
});

ipcMain.on('pty:write', (_event, { id, data } = {}) => {
  ptyManager.write(id, data);
});

ipcMain.handle('pty:dispose', (_event, id) => {
  return { ok: ptyManager.dispose(id) };
});

ipcMain.handle('pty:list-distros', () => ptyManager.listWslDistros());

ipcMain.handle('pty:wslpath', (_event, payload) => ptyManager.wslPath(payload));

// ---- Clipboard IPC ----
// The renderer runs with contextIsolation; clipboard read/write for the
// terminal's copy-on-select and right-click-paste flows through the main
// process so the renderer needs no node clipboard permission.
ipcMain.handle('clipboard:write', (_event, text) => {
  try {
    clipboard.writeText(String(text ?? ''));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('clipboard:read', () => {
  try {
    return { ok: true, text: clipboard.readText() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

app.whenReady().then(() => {
  store = new Store(app.getPath('userData'));
  // An edit menu gives the renderer standard copy/paste/select-all shortcuts
  // without adding navigation or view entries that would fight the app's own
  // tab keyboard handling.
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'editMenu' }]));
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  appQuitting = true;
  if (webRestart.timer) {
    clearTimeout(webRestart.timer);
    webRestart.timer = null;
  }
  for (const entry of runningProcesses.values()) {
    entry.userStopped = true;
    killProcessTree(entry.child);
  }
  ptyManager.disposeAll();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  appQuitting = true;
  if (webRestart.timer) {
    clearTimeout(webRestart.timer);
    webRestart.timer = null;
  }
  if (rendererServer) {
    rendererServer.close();
    rendererServer = null;
  }
  for (const entry of runningProcesses.values()) {
    entry.userStopped = true;
    killProcessTree(entry.child);
  }
  ptyManager.disposeAll();
});
