'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Resolve the local dsh executable.
 *
 * Priority:
 * 1. A user-configured dsh path.
 * 2. The @deepseek-ai/dsh package bundled in node_modules (run through
 *    Electron's Node mode, ELECTRON_RUN_AS_NODE=1).
 * 3. The `dsh` command found on PATH.
 */
function resolveDshCommand(dshPath) {
  if (dshPath && typeof dshPath === 'string' && dshPath.trim()) {
    const trimmed = dshPath.trim();
    return {
      command: trimmed,
      args: [],
      // On Windows a user may point to dsh.cmd/dsh.bat or a PATH name; shell
      // mode lets cmd.exe resolve both batch files and executables safely.
      shell: process.platform === 'win32',
      env: {},
    };
  }

  try {
    const resolved = path.normalize(require.resolve('@deepseek-ai/dsh/lib/bin.js'));
    // electron-builder asarUnpack rewrites physical files to app.asar.unpacked.
    const unpacked = resolved
      .split(path.sep)
      .map((part) => (part === 'app.asar' ? 'app.asar.unpacked' : part))
      .join(path.sep);
    const binPath = fs.existsSync(unpacked) ? unpacked : resolved;
    if (fs.existsSync(binPath)) {
      return {
        command: process.execPath,
        args: [binPath],
        shell: false,
        env: { ELECTRON_RUN_AS_NODE: '1' },
      };
    }
  } catch (_) {
    // Not bundled; fall back to PATH.
  }

  return {
    command: 'dsh',
    args: [],
    shell: process.platform === 'win32',
    env: {},
  };
}

/**
 * Escape a single argument for PowerShell single-quoted literals.
 */
function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Escape a single argument for POSIX shell single-quoted literals.
 */
function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\''`)}'`;
}

/**
 * Build a PowerShell command line that invokes dsh with the given argv.
 */
function buildPowerShellCommand(dshPath, args) {
  const dsh = dshPath && dshPath.trim() ? dshPath.trim() : 'dsh';
  const parts = [`& ${psQuote(dsh)}`];
  for (const arg of args || []) {
    parts.push(psQuote(arg));
  }
  return `$ErrorActionPreference='Stop'; ${parts.join(' ')}`;
}

/**
 * Build the spawn descriptor for a connection.
 *
 * @param {object} connection connection profile
 * @param {string[]} args dsh arguments
 * @param {object} [options] { cwd, env }
 * @returns {{command: string, args: string[], options: object}}
 */
function buildSpawnDescriptor(connection, args, options = {}) {
  const requestedCwd = options.cwd || connection.cwd || '';
  const cwd = requestedCwd || process.cwd();
  const env = { ...process.env, ...(options.env || {}) };

  if (!connection || connection.type === 'local' || !['wsl', 'powershell'].includes(connection.type)) {
    const local = resolveDshCommand(connection && connection.dshPath);
    return {
      command: local.command,
      args: [...local.args, ...args],
      options: {
        cwd,
        env: { ...env, ...local.env },
        shell: local.shell,
        windowsHide: true,
      },
    };
  }

  if (connection.type === 'wsl') {
    const wslPath = connection.wslPath || 'wsl.exe';
    const wslArgs = [];
    if (connection.wslDistro) {
      wslArgs.push('-d', connection.wslDistro);
    }
    if (requestedCwd) {
      wslArgs.push('--cd', requestedCwd);
    }
    const remoteDsh = connection.dshPath && connection.dshPath.trim()
      ? connection.dshPath.trim()
      : 'dsh';
    if (connection.wslLoginShell) {
      // Use an interactive shell so WSL user profiles (.bashrc / nvm / pyenv) are
      // loaded before dsh is executed, matching what the user sees in a WSL terminal.
      const commandLine = [remoteDsh, ...args].map(shQuote).join(' ');
      wslArgs.push('--', 'bash', '-ic', commandLine);
    } else {
      wslArgs.push('--', remoteDsh, ...args);
    }

    // If this Electron app was started through `npm start`, npm injects
    // <app>/node_modules/.bin into PATH. WSL would then resolve `dsh` to the
    // Windows-side local npm shim instead of the real dsh inside WSL. Remove
    // those local .bin entries before handing PATH to WSL.
    const wslEnv = { ...env };
    for (const key of Object.keys(wslEnv)) {
      if (key.toLowerCase() !== 'path' || typeof wslEnv[key] !== 'string') continue;
      const separator = wslEnv[key].includes(';') ? ';' : ':';
      wslEnv[key] = wslEnv[key]
        .split(separator)
        .filter((entry) => !/node_modules[\\/]\.bin$/i.test(entry.trim()))
        .join(separator);
    }

    return {
      command: wslPath,
      args: wslArgs,
      options: {
        cwd: undefined,
        env: wslEnv,
        shell: false,
        windowsHide: true,
      },
    };
  }

  if (connection.type === 'powershell') {
    const ps = connection.powershell || 'powershell.exe';
    return {
      command: ps,
      args: [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        buildPowerShellCommand(connection.dshPath, args),
      ],
      options: {
        cwd,
        env,
        shell: false,
        windowsHide: true,
      },
    };
  }

  throw new Error(`Unsupported connection type: ${connection.type}`);
}

/**
 * Spawn a dsh invocation through a connection profile.
 * @returns {import('node:child_process').ChildProcess}
 */
function spawnDsh(connection, args, options = {}) {
  const descriptor = buildSpawnDescriptor(connection, args, options);
  return require('node:child_process').spawn(
    descriptor.command,
    descriptor.args,
    descriptor.options,
  );
}

/**
 * Run a short dsh command and collect all output.
 * Used by connection tests and version checks.
 */
function runDshCaptured(connection, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnDsh(connection, args, options);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });
}

module.exports = {
  resolveDshCommand,
  buildSpawnDescriptor,
  spawnDsh,
  runDshCaptured,
  buildPowerShellCommand,
  shQuote,
};
