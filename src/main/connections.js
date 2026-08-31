'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { runDshCaptured } = require('./dsh');

const CONNECTIONS_FILE = 'connections.json';
const SETTINGS_FILE = 'settings.json';

function defaultConnections() {
  return [
    {
      id: 'local-default',
      name: '本机 dsh',
      type: 'local',
      dshPath: '',
      cwd: '',
      enabled: true,
    },
    {
      id: 'wsl-example',
      name: 'WSL (示例)',
      type: 'wsl',
      wslPath: 'wsl.exe',
      wslDistro: 'Ubuntu',
      dshPath: 'dsh',
      cwd: '',
      wslLoginShell: true,
      enabled: false,
    },
    {
      id: 'powershell-example',
      name: 'PowerShell (示例)',
      type: 'powershell',
      powershell: 'powershell.exe',
      dshPath: 'dsh',
      cwd: '',
      enabled: false,
    },
  ];
}

class Store {
  constructor(userDataPath) {
    this.dir = userDataPath;
    this.connectionsPath = path.join(userDataPath, CONNECTIONS_FILE);
    this.settingsPath = path.join(userDataPath, SETTINGS_FILE);
    this.ensureDir();
  }

  ensureDir() {
    fs.mkdirSync(this.dir, { recursive: true });
  }

  readJson(filePath, fallback) {
    try {
      if (fs.existsSync(filePath)) {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
      }
    } catch (_) {
      // ignore corrupt file
    }
    return fallback;
  }

  writeJson(filePath, value) {
    this.ensureDir();
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
  }

  getConnections() {
    const list = this.readJson(this.connectionsPath, null);
    if (!Array.isArray(list)) {
      const initial = defaultConnections();
      this.writeJson(this.connectionsPath, initial);
      return initial;
    }
    return list;
  }

  saveConnections(connections) {
    const safe = Array.isArray(connections) ? connections : [];
    this.writeJson(this.connectionsPath, safe);
    return safe;
  }

  getSettings() {
    const settings = this.readJson(this.settingsPath, {});
    return {
      activeConnectionId: 'local-default',
      defaultCwd: '',
      webPort: 0,
      // Restart dsh automatically when it dies without an explicit user stop.
      autoRestart: true,
      appearance: {},
      // Terminal (PTY) personalization. Empty object lets the renderer apply
      // its own defaults while persisting user changes across restarts.
      terminal: {},
      // Persisted tab layout (Firefox-style). Array of tab descriptors plus
      // the active tab id; restored on app startup.
      tabs: [],
      activeTabId: '',
      ...settings,
    };
  }

  saveSettings(settings) {
    const safe = { ...settings };
    this.writeJson(this.settingsPath, safe);
    return safe;
  }
}

async function testConnection(connection) {
  const startedAt = Date.now();
  const result = await runDshCaptured(connection, ['--version'], { cwd: connection.cwd });
  const stderr = result.stderr
    .split(/\r?\n/)
    .filter((line) => !/(cannot set terminal process group|no job control in this shell)/i.test(line))
    .join('\n')
    .trim();
  return {
    ok: result.code === 0,
    code: result.code,
    signal: result.signal,
    stdout: result.stdout.trim(),
    stderr,
    durationMs: Date.now() - startedAt,
    commandLine: describeConnection(connection),
  };
}

function describeConnection(connection) {
  if (connection.type === 'wsl') {
    return `WSL${connection.wslDistro ? ` (${connection.wslDistro})` : ''}: ${connection.dshPath || 'dsh'}`;
  }
  if (connection.type === 'powershell') {
    return `PowerShell (${connection.powershell || 'powershell.exe'}): ${connection.dshPath || 'dsh'}`;
  }
  return `Local: ${connection.dshPath || 'auto (PATH or bundled dsh)'}`;
}

module.exports = { Store, testConnection, describeConnection, defaultConnections };
