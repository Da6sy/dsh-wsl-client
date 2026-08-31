'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dshApp', {
  // Window controls
  minimizeWindow: () => ipcRenderer.send('window:minimize'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('window:toggle-maximize'),
  isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
  closeWindow: () => ipcRenderer.send('window:close'),
  onMaximizedChange: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('window:maximized-change', listener);
    return () => ipcRenderer.removeListener('window:maximized-change', listener);
  },

  // Connections
  listConnections: () => ipcRenderer.invoke('connections:list'),
  saveConnections: (connections) => ipcRenderer.invoke('connections:save', connections),
  testConnection: (connection) => ipcRenderer.invoke('connections:test', connection),

  // Settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (settings) => ipcRenderer.invoke('settings:set', settings),

  // General dsh CLI
  runDsh: (payload) => ipcRenderer.invoke('dsh:run', payload),
  stopDsh: (id) => ipcRenderer.invoke('dsh:stop', id),
  onDshOutput: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('dsh:output', listener);
    return () => ipcRenderer.removeListener('dsh:output', listener);
  },
  onDshExit: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('dsh:exit', listener);
    return () => ipcRenderer.removeListener('dsh:exit', listener);
  },

  // Embedded dsh web
  startWeb: (payload) => ipcRenderer.invoke('dsh:web:start', payload),
  stopWeb: () => ipcRenderer.invoke('dsh:web:stop'),
  webStatus: () => ipcRenderer.invoke('dsh:web:status'),
  onWebUrl: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('dsh:web:url', listener);
    return () => ipcRenderer.removeListener('dsh:web:url', listener);
  },
  onWebExit: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('dsh:web:exit', listener);
    return () => ipcRenderer.removeListener('dsh:web:exit', listener);
  },
  onWebRestarting: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('dsh:web:restarting', listener);
    return () => ipcRenderer.removeListener('dsh:web:restarting', listener);
  },
  onWebRestartFailed: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('dsh:web:restart-failed', listener);
    return () => ipcRenderer.removeListener('dsh:web:restart-failed', listener);
  },

  // UI
  selectBackgroundImage: () => ipcRenderer.invoke('dialog:select-image'),
  fetchText: (url) => ipcRenderer.invoke('http:fetch-text', url),

  // Terminal (PTY)
  createPty: (options) => ipcRenderer.invoke('pty:create', options),
  resizePty: (id, cols, rows) => ipcRenderer.invoke('pty:resize', { id, cols, rows }),
  writePty: (id, data) => ipcRenderer.send('pty:write', { id, data }),
  disposePty: (id) => ipcRenderer.invoke('pty:dispose', id),
  listDistros: () => ipcRenderer.invoke('pty:list-distros'),
  wslPath: (payload) => ipcRenderer.invoke('pty:wslpath', payload),
  onPtyData: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('pty:data', listener);
    return () => ipcRenderer.removeListener('pty:data', listener);
  },
  onPtyExit: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('pty:exit', listener);
    return () => ipcRenderer.removeListener('pty:exit', listener);
  },

  // Clipboard (terminal copy/paste)
  clipboardWrite: (text) => ipcRenderer.invoke('clipboard:write', text),
  clipboardRead: () => ipcRenderer.invoke('clipboard:read'),
});
