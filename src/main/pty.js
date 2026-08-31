'use strict';

const os = require('node:os');
const { execFile } = require('node:child_process');

/**
 * PTY session manager for the built-in terminal tabs.
 *
 * Each session is a node-pty pseudo terminal running one of:
 *  - a WSL distro shell through wsl.exe (Windows only)
 *  - a local shell (PowerShell on Windows, $SHELL/bash elsewhere)
 *  - an explicit PowerShell/pwsh executable
 *
 * Output is forwarded to the renderer as strings; the renderer drives
 * xterm.js. All ids are opaque within this process.
 */
class PtyManager {
  constructor() {
    this.sessions = new Map();
    this.sequence = 0;
  }

  /**
   * Require node-pty lazily so a missing/broken native module surfaces as a
   * readable create() error instead of crashing the main process at startup.
   */
  pty() {
    if (this._pty === undefined) {
      this._pty = require('node-pty');
    }
    return this._pty;
  }

  /**
   * Build the spawn descriptor for a terminal session.
   * @param {object} options { shell: 'wsl'|'local'|'powershell', distro, cwd, connection }
   * @returns {{command: string, args: string[]}}
   */
  resolveShell(options = {}) {
    const shell = options.shell || 'local';
    const connection = options.connection || {};
    const cwd = options.cwd || '';

    if (shell === 'wsl') {
      if (process.platform !== 'win32') {
        throw new Error('WSL 终端仅支持 Windows（当前系统无法启动 wsl.exe）');
      }
      const wsl = connection.wslPath || 'wsl.exe';
      const args = [];
      if (options.distro) args.push('-d', options.distro);
      if (cwd) args.push('--cd', cwd);
      return { command: wsl, args };
    }

    if (shell === 'powershell') {
      const ps = connection.powershell || (process.platform === 'win32' ? 'powershell.exe' : 'pwsh');
      return { command: ps, args: ['-NoLogo'] };
    }

    // local
    if (process.platform === 'win32') {
      const ps = connection.powershell || 'powershell.exe';
      return { command: ps, args: ['-NoLogo'] };
    }
    const userShell = process.env.SHELL || '/bin/bash';
    return { command: userShell, args: [] };
  }

  /**
   * Create a PTY session.
   * @param {object} options { shell, distro, cwd, cols, rows, connection }
   * @param {(channel: string, payload: object) => void} emit event sink
   * @returns {{id: string, pid: number}}
   */
  create(options, emit) {
    const { command, args } = this.resolveShell(options);
    const cols = Math.max(2, Math.floor(options.cols) || 80);
    const rows = Math.max(2, Math.floor(options.rows) || 24);

    // If the app runs through npm, npm injects <app>/node_modules/.bin into
    // PATH. WSL would then resolve tools to the Windows-side shims. Strip
    // those entries before handing PATH to the child, mirroring dsh.js.
    const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
    if (options.shell === 'wsl') {
      for (const key of Object.keys(env)) {
        if (key.toLowerCase() !== 'path' || typeof env[key] !== 'string') continue;
        const separator = env[key].includes(';') ? ';' : ':';
        env[key] = env[key]
          .split(separator)
          .filter((entry) => !/node_modules[\\/]\.bin$/i.test(entry.trim()))
          .join(separator);
      }
    }

    const descriptor = {
      name: 'xterm-256color',
      cols,
      rows,
      env,
      cwd: options.shell === 'wsl' ? undefined : (options.cwd || os.homedir()),
    };

    const child = this.pty().spawn(command, args, descriptor);
    const id = `pty-${++this.sequence}`;
    const session = { id, child, disposed: false };
    this.sessions.set(id, session);

    child.onData((data) => {
      if (!session.disposed) emit('pty:data', { id, data });
    });
    child.onExit(({ exitCode, signal }) => {
      if (session.disposed) return;
      session.disposed = true;
      this.sessions.delete(id);
      emit('pty:exit', { id, code: exitCode, signal: signal ?? null });
    });

    return { id, pid: child.pid };
  }

  write(id, data) {
    const session = this.sessions.get(id);
    if (session && !session.disposed) session.child.write(String(data));
  }

  resize(id, cols, rows) {
    const session = this.sessions.get(id);
    if (!session || session.disposed) return;
    try {
      session.child.resize(Math.max(2, Math.floor(cols) || 80), Math.max(2, Math.floor(rows) || 24));
    } catch (_) {
      // A resize racing the child's exit is harmless; the exit event owns cleanup.
    }
  }

  dispose(id) {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.disposed = true;
    this.sessions.delete(id);
    try { session.child.kill(); } catch (_) { /* already gone */ }
    return true;
  }

  disposeAll() {
    for (const id of [...this.sessions.keys()]) this.dispose(id);
  }

  /**
   * List installed WSL distros via `wsl.exe --list --quiet`. The output is
   * UTF-16LE on Windows; decode defensively and drop decoration lines.
   * @returns {Promise<{ok: boolean, distros?: string[], defaultDistro?: string, error?: string}>}
   */
  listWslDistros() {
    return new Promise((resolve) => {
      if (process.platform !== 'win32') {
        resolve({ ok: false, error: '仅 Windows 支持 WSL' });
        return;
      }
      execFile('wsl.exe', ['--list', '--quiet'], { windowsHide: true, timeout: 8000 }, (error, stdout) => {
        if (error) {
          resolve({ ok: false, error: error.message });
          return;
        }
        // wsl.exe writes UTF-16LE; execFile decodes as UTF-8 which leaves
        // interleaved NUL bytes. Reinterpret the raw bytes when present.
        let text = stdout;
        if (text.includes('\u0000')) {
          const bytes = Buffer.from(stdout, 'binary');
          text = bytes.toString('utf16le');
        }
        const distros = text
          .replace(/^\uFEFF/, '')
          .split(/\r?\n/)
          .map((line) => line.replace(/\u0000/g, '').replace(/^\*?\s*/, '').trim())
          .filter((line) => line && !/^(Windows Subsystem|适用于 Linux)/i.test(line));
        resolve({ ok: true, distros, defaultDistro: distros[0] || '' });
      });
    });
  }

  /**
   * Convert a Windows path to a WSL path using wslpath.
   * @param {object} payload { distro, path }
   * @returns {Promise<{ok: boolean, path?: string, error?: string}>}
   */
  wslPath(payload = {}) {
    return new Promise((resolve) => {
      if (process.platform !== 'win32') {
        resolve({ ok: false, error: '仅 Windows 支持 WSL' });
        return;
      }
      if (!payload.path || typeof payload.path !== 'string') {
        resolve({ ok: false, error: '缺少路径' });
        return;
      }
      const args = [];
      if (payload.distro) args.push('-d', payload.distro);
      args.push('wslpath', '-a', payload.path);
      execFile('wsl.exe', args, { windowsHide: true, timeout: 8000 }, (error, stdout) => {
        if (error) {
          resolve({ ok: false, error: error.message });
          return;
        }
        const converted = stdout.split(/\r?\n/)[0].replace(/\u0000/g, '').trim();
        resolve(converted ? { ok: true, path: converted } : { ok: false, error: 'wslpath 未返回结果' });
      });
    });
  }
}

module.exports = { PtyManager };
