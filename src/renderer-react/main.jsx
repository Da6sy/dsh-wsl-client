import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { AppWebEntry } from '@deepseek-ai/dsh-client-web'
import { TabBar, NewTabMenu } from './tabbar.jsx'
import { TerminalView, DEFAULT_TERMINAL_CONFIG, TERMINAL_FONT_OPTIONS } from './terminal.jsx'
import './styles.css'

async function fetchBootManifest(baseUrl) {
  let html
  let lastError
  const maxAttempts = 8
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if (window.dshApp?.fetchText) {
        const result = await window.dshApp.fetchText(`${baseUrl}/`)
        if (!result?.ok) throw new Error(result?.error || '获取 boot manifest 失败')
        html = result.text
      } else {
        const response = await fetch(`${baseUrl}/`)
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        html = await response.text()
      }
      break
    } catch (err) {
      lastError = err
      // dsh 的 HTTP 服务可能刚打印出 URL 但尚未真正就绪，尤其是 WSL 端口转发
      // 需要一点时间；这里做几次退避重试，避免首次点击启动失败。
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 250 * attempt))
      }
    }
  }
  if (html === undefined) throw lastError || new Error('获取 boot manifest 失败')
  // dsh 的启动注入格式随版本变过：
  //   旧版（≤0.1.0-rc.8）：<script>window.__DSH_BOOT__ = {...}</script>
  //   新版（≥0.1.1-rc.1）：<script>globalThis["__DSH_BOOT__"] = {...}</script>
  // 两者都接受（含点号/中括号、单双引号变体），这样无论连接跑的是哪个版本的
  // dsh 都能解析，避免版本漂移导致"未能找到 __DSH_BOOT__"。
  const match = html.match(/(?:window|globalThis)(?:\.__DSH_BOOT__|\[\s*["']__DSH_BOOT__["']\s*\])\s*=\s*(\{.*?\})\s*<\/script>/s)
  if (!match) throw new Error('未能在 dsh 页面中找到 __DSH_BOOT__')
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)]
    .map((item) => item[1])
    .filter((src) => !src.includes('/assets/') && !src.startsWith('./assets/') && !src.startsWith('../assets/'))
  return { manifest: JSON.parse(match[1]), scripts }
}

// Serializes shell teardown so the next boot can never start while a previous
// shell is still uninstalling its window globals. Every boot awaits this.
let shellTeardown = Promise.resolve()

function HarnessWebShell({ baseUrl }) {
  const hostRef = useRef(null)
  const entryRef = useRef(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        // Wait for any previous shell to finish disposing + clearing globals
        // before booting a new one (guards a fast stop/restart reconnect).
        await shellTeardown
        if (cancelled) return
        const { manifest, scripts } = await fetchBootManifest(baseUrl)
        if (cancelled) return
        window.__DSH_BOOT__ = manifest
        if (hostRef.current) {
          const entry = new AppWebEntry(hostRef.current)
          entryRef.current = entry
          await entry.run()
          for (const src of scripts) {
            const exists = [...document.querySelectorAll('script[data-dsh-plugin-src]')]
              .some((script) => script.dataset.dshPluginSrc === src)
            if (cancelled || exists) continue
            const script = document.createElement('script')
            script.defer = true
            script.dataset.dshPluginSrc = src
            script.src = new URL(src, window.location.href).href
            document.body.appendChild(script)
          }
        }
      } catch (err) {
        if (!cancelled) setError(err.message)
      }
    })()
    return () => {
      cancelled = true
      const entry = entryRef.current
      entryRef.current = null
      // Full teardown: React tree + Cordis fiber tree (WebSocket connections,
      // timers, listeners), then clear every window global the boot kernel and
      // this renderer install. Chained into shellTeardown so the next boot
      // (which awaits it) cannot observe a leftover global and fail with
      // "client-modules: window.__ModuleLoader__ already installed".
      shellTeardown = Promise.resolve(entry?.dispose?.())
        .catch(() => {})
        .then(() => {
          try { delete window.__ModuleLoader__ } catch (_) { window.__ModuleLoader__ = undefined }
          try { delete window.__DSH_MODULES__ } catch (_) { window.__DSH_MODULES__ = undefined }
          try { delete window.__DSH_BOOT__ } catch (_) { window.__DSH_BOOT__ = undefined }
        })
      document.querySelectorAll('script[data-dsh-plugin-src]').forEach((script) => script.remove())
      document.querySelectorAll('style[data-plugin]').forEach((style) => style.remove())
      document.querySelectorAll('[class*="dshwv-"]').forEach((element) => element.remove())
    }
  }, [baseUrl])

  if (error) {
    return <div style={{ padding: 24, color: '#f66' }}>Web Shell 启动失败：{error}</div>
  }

  return <div ref={hostRef} style={{ width: '100%', height: '100%' }} />
}

const DEFAULT_APPEARANCE = {
  bgImage: 'none',
  bgOpacity: 25,
  accent: '#4f8cff',
  glassBlur: 26,
  dshInputOpacity: 94,
  dshSettingsOpacity: 94,
  modules: {
    titlebar: 50,
    sidebar: 72,
    panel: 72,
    harness: 78,
    drawer: 82,
    overlay: 72,
    tabbar: 60,
    terminal: 88,
  },
}

function applyAppearance(appearance = DEFAULT_APPEARANCE) {
  const root = document.documentElement
  const bg = appearance.bgImage || 'none'
  const bgCss = bg && bg !== 'none' ? `url("${bg}")` : 'none'
  const opacity = Number(appearance.bgOpacity ?? 25) / 100
  const accent = appearance.accent || '#4f8cff'
  const blur = Number(appearance.glassBlur ?? 26)
  const inputOpacity = Math.min(100, Math.max(0, Number(appearance.dshInputOpacity ?? 94))) / 100
  const settingsOpacity = Math.min(100, Math.max(0, Number(appearance.dshSettingsOpacity ?? 94))) / 100
  root.style.setProperty('--bg-image', bgCss)
  root.style.setProperty('--bg-opacity', String(opacity))
  root.style.setProperty('--accent', accent)
  root.style.setProperty('--blur', `${blur}px`)
  root.style.setProperty('--dsh-input-bg', `rgba(14, 18, 26, ${inputOpacity})`)
  root.style.setProperty('--dsh-settings-bg', `rgba(10, 13, 19, ${settingsOpacity})`)

  const modules = [
    { key: 'titlebar', css: '--titlebar-bg', rgb: '8, 10, 15', def: 50 },
    { key: 'sidebar', css: '--sidebar-bg', rgb: '8, 10, 15', def: 72 },
    { key: 'panel', css: '--panel-bg', rgb: '14, 18, 26', def: 72 },
    { key: 'harness', css: '--harness-bg', rgb: '13, 18, 28', def: 78 },
    { key: 'drawer', css: '--drawer-bg', rgb: '10, 13, 19', def: 82 },
    { key: 'tabbar', css: '--tabbar-bg', rgb: '10, 13, 19', def: 60 },
    { key: 'terminal', css: '--terminal-bg', rgb: '8, 10, 14', def: 88 },
  ]
  for (const mod of modules) {
    const value = Number(appearance.modules?.[mod.key] ?? mod.def)
    root.style.setProperty(mod.css, `rgba(${mod.rgb}, ${Math.min(100, Math.max(0, value)) / 100})`)
  }

  const overlay = Number(appearance.modules?.overlay ?? 72) / 100
  root.style.setProperty('--overlay-bg', `linear-gradient(135deg, rgba(5, 7, 12, ${0.86 * overlay}), rgba(8, 11, 17, ${0.72 * overlay}))`)

  // The app shell is dark by design. Keep the official dsh shell on the dark
  // palette even if dsh's own preference is light/system; otherwise the app's
  // translucent dark surfaces would clash with dsh's light text tokens.
  document.documentElement.style.colorScheme = 'dark'
  document.body.setAttribute('data-ds-dark-theme', '')
}

// ---- Unified setting rows ----
// Every control in the settings panes shares one row layout (label · control ·
// value) so sliders, selects and pickers read as a single integrated list.

function SettingRow({ label, display, children }) {
  return (
    <div className="setting-row">
      <span className="setting-row-label">{label}</span>
      <div className="setting-row-control">{children}</div>
      <span className="setting-row-value">{display ?? ''}</span>
    </div>
  )
}

function SliderRow({ label, min, max, step = 1, value, onChange, unit = '%' }) {
  return (
    <div className="setting-row">
      <span className="setting-row-label">{label}</span>
      <input
        className="setting-row-slider"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={onChange}
      />
      <span className="setting-row-value">{value}{unit}</span>
    </div>
  )
}

function App() {
  const [connections, setConnections] = useState([])
  const [connectionId, setConnectionId] = useState('')
  const [port, setPort] = useState(0)
  const [baseUrl, setBaseUrl] = useState('')
  const [starting, setStarting] = useState(false)
  const [autoRestart, setAutoRestart] = useState(true)
  const [appearance, setAppearance] = useState(DEFAULT_APPEARANCE)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState('connections')
  const [consoleArgs, setConsoleArgs] = useState('')
  const [consoleOutput, setConsoleOutput] = useState('# 输出')
  const [consoleRunId, setConsoleRunId] = useState(null)
  const [maximized, setMaximized] = useState(false)

  // Firefox-style tab management. A tab is either a dsh page (the embedded
  // web shell) or a terminal (node-pty + xterm.js). Layout persists to
  // settings.tabs / settings.activeTabId and is restored on startup.
  const [tabs, setTabs] = useState([{ id: 'tab-dsh-1', type: 'dsh', title: 'DeepSeek Harness' }])
  const [activeTabId, setActiveTabId] = useState('tab-dsh-1')
  // Which dsh tab currently hosts the live Web Shell. Only one AppWebEntry can
  // exist per document, but switching to a TERMINAL tab must not tear it down:
  // the shell stays mounted (hidden) so it never reboots/refreshes when the
  // user comes back. Only activating a DIFFERENT dsh tab moves the mount.
  const [mountedDshTabId, setMountedDshTabId] = useState('tab-dsh-1')
  const [terminalConfig, setTerminalConfig] = useState(DEFAULT_TERMINAL_CONFIG)
  const [newTabMenuOpen, setNewTabMenuOpen] = useState(false)
  const [newTabMenuAnchor, setNewTabMenuAnchor] = useState(null)
  const tabSeqRef = useRef(1)
  const newTabBtnRef = useRef(null)

  const settingsRef = useRef({})

  useEffect(() => {
    applyAppearance()
    const cleanups = []
    const stopGlobalShortcut = (event) => {
      if (event.target instanceof HTMLElement
        && event.target.matches('input, textarea, select')
        && !event.target.closest('.content-area')) {
        event.stopPropagation()
      }
    }
    document.addEventListener('keydown', stopGlobalShortcut, true)
    const themeObserver = new MutationObserver(() => {
      if (!document.body.hasAttribute('data-ds-dark-theme')) {
        document.body.setAttribute('data-ds-dark-theme', '')
      }
    })
    themeObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ['data-ds-dark-theme'],
    })
    if (window.dshApp?.listConnections) {
      Promise.all([
        window.dshApp.listConnections(),
        window.dshApp.getSettings
          ? window.dshApp.getSettings().catch(() => null)
          : Promise.resolve(null),
      ]).then(([list, settings]) => {
        const nextSettings = settings || {}
        settingsRef.current = nextSettings
        // Auto-restart defaults ON; only an explicit false disables it.
        setAutoRestart(nextSettings.autoRestart !== false)
        const legacyAppearance = {
          bgImage: localStorage.getItem('dshApp.bgImage') || 'none',
          bgOpacity: Number(localStorage.getItem('dshApp.bgOpacity') ?? 25),
          accent: localStorage.getItem('dshApp.accent') || '#4f8cff',
          glassBlur: Number(localStorage.getItem('dshApp.glassBlur') ?? 26),
          dshInputOpacity: Number(localStorage.getItem('dshApp.dshInputOpacity') ?? 94),
          dshSettingsOpacity: Number(localStorage.getItem('dshApp.dshSettingsOpacity') ?? 94),
          modules: Object.fromEntries(Object.keys(DEFAULT_APPEARANCE.modules).map((key) => [
            key,
            Number(localStorage.getItem(`dshApp.module.${key}`) ?? DEFAULT_APPEARANCE.modules[key]),
          ])),
        }
        const storedAppearance = Object.keys(nextSettings.appearance || {}).length
          ? nextSettings.appearance
          : legacyAppearance
        const nextAppearance = {
          ...DEFAULT_APPEARANCE,
          ...storedAppearance,
          modules: { ...DEFAULT_APPEARANCE.modules, ...(storedAppearance.modules || {}) },
        }
        settingsRef.current = { ...nextSettings, appearance: nextAppearance }
        if (!Object.keys(nextSettings.appearance || {}).length) {
          window.dshApp.setSettings(settingsRef.current).catch(() => {})
        }
        setAppearance(nextAppearance)
        applyAppearance(nextAppearance)
        setConnections(list || [])
        if (list?.length) {
          const activeId = nextSettings.activeConnectionId
          setConnectionId(list.some((connection) => connection.id === activeId)
            ? activeId
            : list[0].id)
        }
        // Terminal personalization + persisted tab layout.
        setTerminalConfig({ ...DEFAULT_TERMINAL_CONFIG, ...(nextSettings.terminal || {}) })
        const restoredTabs = Array.isArray(nextSettings.tabs) && nextSettings.tabs.length
          ? nextSettings.tabs.filter((tab) => tab && (tab.type === 'dsh' || tab.type === 'terminal'))
          : null
        if (restoredTabs && restoredTabs.length) {
          setTabs(restoredTabs)
          const restoredActiveId = restoredTabs.some((tab) => tab.id === nextSettings.activeTabId)
            ? nextSettings.activeTabId
            : restoredTabs[0].id
          setActiveTabId(restoredActiveId)
          // The shell mounts on the active tab when that is a dsh tab,
          // otherwise on the first dsh tab (kept suspended until activated).
          const restoredActiveTab = restoredTabs.find((tab) => tab.id === restoredActiveId)
          const restoredMountId = restoredActiveTab?.type === 'dsh'
            ? restoredActiveTab.id
            : (restoredTabs.find((tab) => tab.type === 'dsh')?.id ?? '')
          setMountedDshTabId(restoredMountId)
        }
      })
    }
    if (window.dshApp?.webStatus) {
      window.dshApp.webStatus().then((status) => {
        if (status?.url) setBaseUrl(status.url)
      })
    }
    if (window.dshApp?.isMaximized) {
      window.dshApp.isMaximized().then(setMaximized)
      window.dshApp.onMaximizedChange(setMaximized)
    }
    if (window.dshApp?.onDshOutput) {
      window.dshApp.onDshOutput((payload) => setConsoleOutput((prev) => prev + payload.text))
    }
    if (window.dshApp?.onDshExit) {
      window.dshApp.onDshExit((payload) => {
        setConsoleOutput((prev) => prev + `\n[已退出 code=${payload.code} signal=${payload.signal || ''}]\n`)
        setConsoleRunId(null)
      })
    }
    if (window.dshApp?.onWebUrl) {
      cleanups.push(window.dshApp.onWebUrl(({ url }) => {
        if (url) {
          setBaseUrl(url)
          setStarting(false)
        }
      }))
    }
    if (window.dshApp?.onWebExit) {
      cleanups.push(window.dshApp.onWebExit((payload = {}) => {
        // A pending auto-restart keeps the (stale) URL so the shell can ride
        // out the gap on its own reconnect backoff; a final exit clears it.
        if (payload.willRestart) {
          setStarting(true)
        } else {
          setBaseUrl('')
          setStarting(false)
        }
        if (payload.error) {
          setConsoleOutput((prev) => `${prev}\n[Harness 进程错误] ${payload.error}\n`)
        } else {
          const reason = payload.reason || `code=${payload.code}`
          setConsoleOutput((prev) => `${prev}\n[Harness] dsh 进程退出：${reason}${payload.willRestart ? '，即将自动重启…' : ''}\n`)
        }
      }))
    }
    if (window.dshApp?.onWebRestarting) {
      cleanups.push(window.dshApp.onWebRestarting(() => {
        setStarting(true)
      }))
    }
    if (window.dshApp?.onWebRestartFailed) {
      cleanups.push(window.dshApp.onWebRestartFailed(({ error }) => {
        setStarting(false)
        setBaseUrl('')
        setConsoleOutput((prev) => `${prev}\n[自动重启失败] ${error || '未知错误'}\n`)
      }))
    }
    return () => {
      themeObserver.disconnect()
      document.removeEventListener('keydown', stopGlobalShortcut, true)
      cleanups.forEach((cleanup) => cleanup?.())
    }
  }, [])

  // ---- Tab management ----

  const persistTabs = (nextTabs, nextActiveId) => {
    settingsRef.current = { ...settingsRef.current, tabs: nextTabs, activeTabId: nextActiveId }
    window.dshApp?.setSettings?.(settingsRef.current).catch(() => {})
  }

  const addTab = (type) => {
    setNewTabMenuOpen(false)
    const seq = ++tabSeqRef.current
    let tab
    if (type === 'terminal') {
      const connection = connections.find((c) => c.id === connectionId) || connections[0] || { type: 'local' }
      const shell = connection.type === 'wsl' ? 'wsl' : connection.type === 'powershell' ? 'powershell' : 'local'
      const title = shell === 'wsl'
        ? `WSL${connection.wslDistro ? ` · ${connection.wslDistro}` : ''}`
        : shell === 'powershell' ? 'PowerShell' : '本机终端'
      tab = {
        id: `tab-term-${Date.now().toString(36)}-${seq}`,
        type: 'terminal',
        title,
        shell,
        connectionId: connection.id,
        distro: connection.wslDistro || '',
        cwd: connection.cwd || '',
      }
    } else {
      tab = { id: `tab-dsh-${Date.now().toString(36)}-${seq}`, type: 'dsh', title: 'DeepSeek Harness' }
    }
    const nextTabs = [...tabs, tab]
    setTabs(nextTabs)
    setActiveTabId(tab.id)
    // A fresh dsh tab takes over the live shell (single AppWebEntry per
    // document); the previous dsh tab becomes suspended.
    if (type === 'dsh') setMountedDshTabId(tab.id)
    persistTabs(nextTabs, tab.id)
  }

  const closeTab = (id) => {
    const index = tabs.findIndex((tab) => tab.id === id)
    if (index === -1) return
    let nextTabs = tabs.filter((tab) => tab.id !== id)
    if (!nextTabs.length) {
      // The strip never goes empty: a closed last tab is replaced by a fresh dsh tab.
      nextTabs = [{ id: `tab-dsh-${Date.now().toString(36)}-r`, type: 'dsh', title: 'DeepSeek Harness' }]
    }
    setTabs(nextTabs)
    const nextActive = activeTabId === id ? nextTabs[Math.max(0, index - 1)].id : activeTabId
    if (nextActive !== activeTabId) setActiveTabId(nextActive)
    // Hand the live shell to a surviving dsh tab when its host tab is closed.
    if (mountedDshTabId === id) {
      const nextActiveTab = nextTabs.find((tab) => tab.id === nextActive)
      const mountTarget = nextActiveTab?.type === 'dsh'
        ? nextActiveTab.id
        : (nextTabs.find((tab) => tab.type === 'dsh')?.id ?? '')
      setMountedDshTabId(mountTarget)
    }
    persistTabs(nextTabs, nextActive)
  }

  const selectTab = (id) => {
    if (id === activeTabId) return
    const target = tabs.find((tab) => tab.id === id)
    // Move the live shell ONLY when switching to a different dsh tab.
    // Switching to a terminal tab leaves the shell mounted (hidden), so
    // coming back never reboots/refreshes it.
    if (target?.type === 'dsh' && id !== mountedDshTabId) setMountedDshTabId(id)
    setActiveTabId(id)
    persistTabs(tabs, id)
  }

  const reorderTabs = (from, to) => {
    if (from === to || from < 0 || to < 0 || from >= tabs.length || to >= tabs.length) return
    const nextTabs = [...tabs]
    const [moved] = nextTabs.splice(from, 1)
    nextTabs.splice(to, 0, moved)
    setTabs(nextTabs)
    persistTabs(nextTabs, activeTabId)
  }

  const cycleTab = (direction) => {
    if (tabs.length < 2) return
    const index = tabs.findIndex((tab) => tab.id === activeTabId)
    const next = tabs[(index + direction + tabs.length) % tabs.length]
    selectTab(next.id)
  }

  const jumpTab = (position) => {
    if (!tabs.length) return
    const target = position >= tabs.length ? tabs[tabs.length - 1] : tabs[position]
    selectTab(target.id)
  }

  // Firefox-style shortcuts: Ctrl+Tab / Ctrl+Shift+Tab cycle, Ctrl+1..9 jump,
  // Ctrl+T new dsh tab, Ctrl+Shift+T new terminal tab, Ctrl+W close.
  useEffect(() => {
    const onKeyDown = (event) => {
      if (!event.ctrlKey || event.metaKey || event.altKey) return
      const key = event.key.toLowerCase()
      if (key === 'tab') {
        event.preventDefault()
        event.stopPropagation()
        cycleTab(event.shiftKey ? -1 : 1)
      } else if (key >= '1' && key <= '9') {
        event.preventDefault()
        event.stopPropagation()
        jumpTab(Number(key) - 1)
      } else if (key === 't') {
        event.preventDefault()
        event.stopPropagation()
        addTab(event.shiftKey ? 'terminal' : 'dsh')
      } else if (key === 'w') {
        event.preventDefault()
        event.stopPropagation()
        closeTab(activeTabId)
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  })

  const setTerminalConfigField = (field, value) => {
    const next = { ...terminalConfig, [field]: value }
    setTerminalConfig(next)
    settingsRef.current = { ...settingsRef.current, terminal: next }
    window.dshApp?.setSettings?.(settingsRef.current).catch(() => {})
  }

  const start = async () => {
    setStarting(true)
    try {
      const result = await window.dshApp.startWeb({ connectionId, port: Number(port) || 0, host: '127.0.0.1' })
      if (result?.url) setBaseUrl(result.url)
      else if (!result?.ok) alert(`启动失败：${result?.error || '未知错误'}`)
      else setConsoleOutput((prev) => `${prev}\n[Harness] dsh 已启动，正在等待服务地址…\n`)
    } catch (err) {
      alert(`启动异常：${err.message}`)
    } finally {
      setStarting(false)
    }
  }

  const stop = async () => {
    await window.dshApp.stopWeb()
    setBaseUrl('')
  }

  const runConsole = async () => {
    const args = consoleArgs.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((s) => s.replace(/^["']|["']$/g, '')) || []
    setConsoleOutput((prev) => `${prev}\n$ dsh ${args.join(' ')}\n`)
    try {
      const result = await window.dshApp.runDsh({ connectionId, args })
      if (result?.ok) {
        setConsoleRunId(result.id)
        setConsoleOutput((prev) => `${prev}[pid ${result.pid}] 已启动\n`)
      } else {
        setConsoleOutput((prev) => `${prev}[启动失败] ${result?.error || ''}\n`)
      }
    } catch (err) {
      setConsoleOutput((prev) => `${prev}[调用失败] ${err.message}\n`)
    }
  }

  const stopConsole = async () => {
    if (consoleRunId) await window.dshApp.stopDsh(consoleRunId)
    setConsoleRunId(null)
  }

  const selectBg = async () => {
    const result = await window.dshApp.selectBackgroundImage()
    if (!result?.canceled && result?.dataUrl) {
      const next = { ...appearance, bgImage: result.dataUrl }
      setAppearance(next)
      applyAppearance(next)
      settingsRef.current = { ...settingsRef.current, appearance: next }
      await window.dshApp.setSettings(settingsRef.current)
    }
  }

  const removeBg = async () => {
    const next = { ...appearance, bgImage: 'none' }
    setAppearance(next)
    applyAppearance(next)
    settingsRef.current = { ...settingsRef.current, appearance: next }
    await window.dshApp.setSettings(settingsRef.current)
  }

  const setRange = (key) => (e) => {
    const value = e.target.value
    const next = { ...appearance, modules: { ...appearance.modules } }
    if (key === 'dshApp.bgOpacity') next.bgOpacity = Number(value)
    else if (key === 'dshApp.accent') next.accent = value
    else if (key === 'dshApp.glassBlur') next.glassBlur = Number(value)
    else if (key === 'dshApp.dshInputOpacity') next.dshInputOpacity = Number(value)
    else if (key === 'dshApp.dshSettingsOpacity') next.dshSettingsOpacity = Number(value)
    else if (key.startsWith('dshApp.module.')) next.modules[key.slice('dshApp.module.'.length)] = Number(value)
    setAppearance(next)
    applyAppearance(next)
    settingsRef.current = { ...settingsRef.current, appearance: next }
    window.dshApp.setSettings(settingsRef.current).catch(() => {})
  }

  const saveConnections = async () => {
    const result = await window.dshApp.saveConnections(connections)
    setConnections(result || [])
    const activeId = result?.some((connection) => connection.id === connectionId)
      ? connectionId
      : result?.[0]?.id
    if (activeId) {
      const settings = await window.dshApp.getSettings()
      const nextSettings = {
        ...settings,
        activeConnectionId: activeId,
        webPort: Number(port) || 0,
        autoRestart,
        appearance,
      }
      settingsRef.current = nextSettings
      await window.dshApp.setSettings(nextSettings)
    }
    alert('连接已保存')
  }

  const updateConnection = (index, field, value) => {
    setConnections((prev) => prev.map((c, i) => i === index ? { ...c, [field]: value } : c))
  }

  const removeConnection = (id) => {
    if (connections.length <= 1) {
      alert('至少需要保留一个连接。')
      return
    }
    const connection = connections.find((item) => item.id === id)
    if (!connection || !window.confirm(`确定删除连接“${connection.name || id}”吗？`)) return

    const remaining = connections.filter((item) => item.id !== id)
    setConnections(remaining)
    if (connectionId === id) setConnectionId(remaining[0].id)
  }

  const openSettings = (tab) => {
    setSettingsTab(tab)
    setSettingsOpen(true)
  }

  return (
    <div className="app">
      <div className="app-bg" />
      <div className="app-overlay" />

      <div className="titlebar">
        <div className="titlebar-title">
          <span className="titlebar-dot" />
          DeepSeek Harness
        </div>
        <div className="window-controls">
          <button onClick={() => window.dshApp?.minimizeWindow()}>─</button>
          <button onClick={async () => {
            const max = await window.dshApp?.toggleMaximizeWindow()
            setMaximized(Boolean(max))
          }}>{maximized ? '❐' : '□'}</button>
          <button className="close" onClick={() => window.dshApp?.closeWindow()}>✕</button>
        </div>
      </div>

      <div className="app-body">
        <div className="topbar">
          <div className="brand">DSH</div>
          <span className={`badge ${baseUrl ? 'running' : ''}`}>{baseUrl ? '运行中' : '未运行'}</span>
          <button onClick={() => openSettings('connections')} style={{ marginLeft: 'auto' }}>设置</button>
        </div>

        <div className="tabstrip">
          <TabBar
            tabs={tabs}
            activeTabId={activeTabId}
            onSelect={selectTab}
            onClose={closeTab}
            onReorder={reorderTabs}
          />
          <div className="newtab-anchor">
            <button
              ref={newTabBtnRef}
              className="newtab-btn"
              title="新建标签页"
              aria-haspopup="menu"
              onClick={() => {
                if (newTabMenuOpen) {
                  setNewTabMenuOpen(false)
                  return
                }
                // Anchor the portaled menu to the button; the menu itself
                // renders on document.body (see NewTabMenu).
                const rect = newTabBtnRef.current?.getBoundingClientRect()
                setNewTabMenuAnchor(rect
                  ? { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right }
                  : null)
                setNewTabMenuOpen(true)
              }}
            >
              +
            </button>
          </div>
        </div>
        <NewTabMenu
          open={newTabMenuOpen}
          anchorRect={newTabMenuAnchor}
          onPick={addTab}
          onClose={() => setNewTabMenuOpen(false)}
        />

        <div className="content-area">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={`tab-panel ${tab.id === activeTabId ? 'active' : ''}`}
              role="tabpanel"
            >
              {tab.type === 'dsh'
                ? (tab.id !== mountedDshTabId
                    // Only one AppWebEntry can live in this document (its boot
                    // owns window globals). The shell stays mounted on the ONE
                    // mountedDshTabId tab — even while that tab is hidden behind
                    // a terminal tab — so it never reboots on tab switches.
                    // Other dsh tabs are suspended and re-boot when activated.
                    ? <div className="tab-empty">dsh 页面已挂起，切换到此标签页时自动恢复</div>
                    : baseUrl
                      ? <HarnessWebShell key={baseUrl} baseUrl={baseUrl} />
                      : (
                        <div className="tab-empty">
                          <p>Harness 未运行</p>
                          <button className="primary" onClick={start} disabled={starting}>{starting ? '启动中…' : '启动 Harness'}</button>
                        </div>
                      ))
                : (
                  <TerminalView
                    tab={tab}
                    active={tab.id === activeTabId}
                    config={terminalConfig}
                    accent={appearance.accent}
                    bgOpacity={Math.min(100, Math.max(0, Number(appearance.modules?.terminal ?? 88))) / 100}
                    connection={connections.find((c) => c.id === tab.connectionId) || null}
                  />
                )}
            </div>
          ))}
        </div>
      </div>

      <div className={`settings-drawer ${settingsOpen ? 'open' : ''}`}>
        <div className="settings-header">
          <h2 style={{ margin: 0, fontSize: 16 }}>设置</h2>
          <button onClick={() => setSettingsOpen(false)}>✕</button>
        </div>
        <div className="settings-tabs">
          {['connections', 'terminal', 'console', 'appearance'].map((tab) => (
            <button key={tab} className={settingsTab === tab ? 'active' : ''} onClick={() => openSettings(tab)}>
              {tab === 'connections' ? '连接' : tab === 'terminal' ? '终端' : tab === 'console' ? '命令台' : '外观'}
            </button>
          ))}
        </div>
        <div className="settings-body">
          <div className={`settings-pane ${settingsTab === 'connections' ? 'active' : ''}`}>
            <div className="connection-toolbar">
              <label>默认连接
                <select value={connectionId} onChange={(e) => setConnectionId(e.target.value)}>
                  {connections.map((c) => <option key={c.id} value={c.id}>{c.name || c.id} ({c.type})</option>)}
                </select>
              </label>
              <label>端口 <input type="number" value={port} onChange={(e) => setPort(e.target.value)} placeholder="0" /></label>
              <button className="primary" onClick={start} disabled={starting}>{starting ? '启动中…' : '启动 Harness'}</button>
              <button onClick={stop} disabled={!baseUrl && !starting}>停止</button>
              <span className={`badge ${baseUrl ? 'running' : ''}`}>{baseUrl ? '运行中' : '未运行'}</span>
            </div>
            <label className="auto-start-row">
              <input type="checkbox" checked={autoRestart} onChange={(e) => {
                const value = e.target.checked
                setAutoRestart(value)
                settingsRef.current = { ...settingsRef.current, autoRestart: value }
                window.dshApp.setSettings(settingsRef.current).catch(() => {})
              }} />
              dsh 意外停止后自动重启（5 分钟内最多 3 次）
            </label>
            <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
              <button className="primary" onClick={() => setConnections((prev) => [...prev, { id: `conn-${Date.now()}`, name: '新连接', type: 'local', dshPath: '' }])}>新增连接</button>
              <button onClick={saveConnections}>保存全部</button>
            </div>
            {connections.map((conn, index) => (
              <div className="conn-card" key={conn.id}>
                <div className="connection-card-header">
                  <label className="default-connection">
                    <input type="radio" name="default-connection" checked={conn.id === connectionId} onChange={() => setConnectionId(conn.id)} />
                    默认
                  </label>
                  <input value={conn.name || ''} onChange={(e) => updateConnection(index, 'name', e.target.value)} placeholder="名称" />
                  <select value={conn.type || 'local'} onChange={(e) => updateConnection(index, 'type', e.target.value)}>
                    <option value="local">本机</option>
                    <option value="wsl">WSL</option>
                    <option value="powershell">PowerShell</option>
                  </select>
                </div>
                <div className="conn-fields">
                  <input value={conn.dshPath || ''} onChange={(e) => updateConnection(index, 'dshPath', e.target.value)} placeholder="dsh 路径" />
                  <input value={conn.cwd || ''} onChange={(e) => updateConnection(index, 'cwd', e.target.value)} placeholder="工作目录" />
                  {conn.type === 'wsl' && (
                    <>
                      <input value={conn.wslDistro || ''} onChange={(e) => updateConnection(index, 'wslDistro', e.target.value)} placeholder="WSL 发行版" />
                      <input value={conn.wslPath || ''} onChange={(e) => updateConnection(index, 'wslPath', e.target.value)} placeholder="wsl.exe 路径" />
                    </>
                  )}
                  {conn.type === 'powershell' && (
                    <input value={conn.powershell || ''} onChange={(e) => updateConnection(index, 'powershell', e.target.value)} placeholder="powershell.exe / pwsh" />
                  )}
                </div>
                <div className="conn-actions">
                  <button onClick={async () => {
                    const result = await window.dshApp.testConnection(conn)
                    alert(`${result.ok ? '✅ 连接成功' : '❌ 连接失败'}\n${result.stdout || result.stderr || ''}`)
                  }}>测试连接</button>
                  <button className="danger" onClick={() => removeConnection(conn.id)}>删除连接</button>
                </div>
              </div>
            ))}
          </div>

          <div className={`settings-pane ${settingsTab === 'console' ? 'active' : ''}`}>
            <div style={{ display: 'grid', gap: 8, marginBottom: 10 }}>
              <input value={consoleArgs} onChange={(e) => setConsoleArgs(e.target.value)} placeholder="--profile headless &quot;run the tests&quot;" />
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="primary" onClick={runConsole}>运行</button>
                <button onClick={stopConsole}>停止</button>
                <button onClick={() => setConsoleOutput('# 输出')}>清空</button>
              </div>
            </div>
            <pre className="console-output">{consoleOutput}</pre>
          </div>

          <div className={`settings-pane ${settingsTab === 'terminal' ? 'active' : ''}`}>
            <div className="settings-hint">
              终端标签页使用 xterm.js 渲染、node-pty 驱动 WSL / 本机伪终端。以下设置即时生效并随应用持久化。
            </div>
            <div className="card">
              <h3 style={{ margin: '0 0 8px' }}>字体</h3>
              <SettingRow label="字体族">
                <select
                  value={terminalConfig.fontFamily}
                  onChange={(e) => setTerminalConfigField('fontFamily', e.target.value)}
                >
                  {TERMINAL_FONT_OPTIONS.map((font) => <option key={font} value={font}>{font}</option>)}
                </select>
              </SettingRow>
              <SliderRow label="字号" min={10} max={26} value={terminalConfig.fontSize} onChange={(e) => setTerminalConfigField('fontSize', Number(e.target.value))} unit="px" />
            </div>
            <div className="card">
              <h3 style={{ margin: '0 0 8px' }}>光标与滚动</h3>
              <SettingRow label="光标样式">
                <select
                  value={terminalConfig.cursorStyle}
                  onChange={(e) => setTerminalConfigField('cursorStyle', e.target.value)}
                >
                  <option value="block">方块</option>
                  <option value="underline">下划线</option>
                  <option value="bar">竖线</option>
                </select>
              </SettingRow>
              <SettingRow label="光标闪烁">
                <select
                  value={terminalConfig.cursorBlink ? 'on' : 'off'}
                  onChange={(e) => setTerminalConfigField('cursorBlink', e.target.value === 'on')}
                >
                  <option value="on">开启</option>
                  <option value="off">关闭</option>
                </select>
              </SettingRow>
              <SettingRow label="回滚行数">
                <input
                  type="number"
                  min="100"
                  max="20000"
                  step="100"
                  value={terminalConfig.scrollback}
                  onChange={(e) => setTerminalConfigField('scrollback', Number(e.target.value) || 5000)}
                />
              </SettingRow>
            </div>
            <div className="card">
              <h3 style={{ margin: '0 0 8px' }}>配色方案</h3>
              <SettingRow label="终端配色">
                <select
                  value={terminalConfig.colorScheme}
                  onChange={(e) => setTerminalConfigField('colorScheme', e.target.value)}
                >
                  <option value="accent">跟随应用强调色</option>
                  <option value="classic">经典</option>
                  <option value="ocean">海洋</option>
                  <option value="paper">纸张</option>
                </select>
              </SettingRow>
              <div className="settings-hint">
                选择“跟随应用强调色”时，终端的光标、选区与蓝色系会随外观里的强调色变化；背景透明度由外观的“终端”模块控制。
              </div>
            </div>
          </div>

          <div className={`settings-pane ${settingsTab === 'appearance' ? 'active' : ''}`}>
            <div className="card">
              <h3 style={{ margin: '0 0 8px' }}>背景</h3>
              <div style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
                <button onClick={selectBg}>选择图片…</button>
                <button onClick={removeBg}>移除背景</button>
              </div>
              <SliderRow label="背景透明度" min={0} max={100} value={appearance.bgOpacity} onChange={setRange('dshApp.bgOpacity')} />
              <SliderRow label="背景遮罩" min={0} max={100} value={appearance.modules.overlay} onChange={setRange('dshApp.module.overlay')} />
              <SliderRow label="毛玻璃强度" min={0} max={48} value={appearance.glassBlur} onChange={setRange('dshApp.glassBlur')} unit="px" />
            </div>
            <div className="card">
              <h3 style={{ margin: '0 0 8px' }}>模块透明度</h3>
              <SliderRow label="标题栏" min={0} max={100} value={appearance.modules.titlebar} onChange={setRange('dshApp.module.titlebar')} />
              <SliderRow label="标签页栏" min={0} max={100} value={appearance.modules.tabbar} onChange={setRange('dshApp.module.tabbar')} />
              <SliderRow label="Harness 侧栏" min={0} max={100} value={appearance.modules.sidebar} onChange={setRange('dshApp.module.sidebar')} />
              <SliderRow label="面板" min={0} max={100} value={appearance.modules.panel} onChange={setRange('dshApp.module.panel')} />
              <SliderRow label="Harness 聊天区" min={0} max={100} value={appearance.modules.harness} onChange={setRange('dshApp.module.harness')} />
              <SliderRow label="设置抽屉" min={0} max={100} value={appearance.modules.drawer} onChange={setRange('dshApp.module.drawer')} />
              <SliderRow label="终端背景" min={0} max={100} value={appearance.modules.terminal} onChange={setRange('dshApp.module.terminal')} />
            </div>
            <div className="card">
              <h3 style={{ margin: '0 0 8px' }}>DSH 界面可读性</h3>
              <SliderRow label="DSH 设置面板" min={40} max={100} value={appearance.dshSettingsOpacity} onChange={setRange('dshApp.dshSettingsOpacity')} />
              <SliderRow label="DSH 文本输入框" min={40} max={100} value={appearance.dshInputOpacity} onChange={setRange('dshApp.dshInputOpacity')} />
            </div>
            <div className="card">
              <h3 style={{ margin: '0 0 8px' }}>强调色</h3>
              <SettingRow label="主题强调色" display={appearance.accent}>
                <input type="color" value={appearance.accent} onChange={setRange('dshApp.accent')} />
              </SettingRow>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')).render(<App />)
