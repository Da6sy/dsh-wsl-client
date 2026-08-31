import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'

export const TERMINAL_FONT_OPTIONS = [
  'Cascadia Code',
  'Cascadia Mono',
  'JetBrains Mono',
  'Fira Code',
  'Source Code Pro',
  'Consolas',
  'Sarasa Mono SC',
  'NSimSun',
]

export const DEFAULT_TERMINAL_CONFIG = {
  fontFamily: 'Cascadia Code',
  fontSize: 14,
  cursorStyle: 'block',
  cursorBlink: true,
  scrollback: 5000,
  // 'accent' follows the app accent color; the rest are fixed palettes.
  colorScheme: 'accent',
}

// Fixed ANSI palettes for the independent-scheme option. 'accent' builds its
// ANSI set around the app accent color instead.
const PALETTES = {
  classic: {
    black: '#1e222a', red: '#e06c75', green: '#98c379', yellow: '#e5c07b',
    blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#dcdfe4',
    brightBlack: '#5c6370', brightRed: '#e06c75', brightGreen: '#98c379',
    brightYellow: '#e5c07b', brightBlue: '#61afef', brightMagenta: '#c678dd',
    brightCyan: '#56b6c2', brightWhite: '#ffffff',
  },
  ocean: {
    black: '#0b141a', red: '#ff5c7a', green: '#3ddc97', yellow: '#ffd166',
    blue: '#4f8cff', magenta: '#c792ea', cyan: '#4dd0e1', white: '#e8edf7',
    brightBlack: '#3d4a56', brightRed: '#ff5c7a', brightGreen: '#3ddc97',
    brightYellow: '#ffd166', brightBlue: '#4f8cff', brightMagenta: '#c792ea',
    brightCyan: '#4dd0e1', brightWhite: '#ffffff',
  },
  paper: {
    black: '#24292f', red: '#cf222e', green: '#116329', yellow: '#9a6700',
    blue: '#0969da', magenta: '#8250df', cyan: '#1b7c83', white: '#f6f8fa',
    brightBlack: '#57606a', brightRed: '#a40e26', brightGreen: '#1a7f37',
    brightYellow: '#b58105', brightBlue: '#218bff', brightMagenta: '#a475f9',
    brightCyan: '#3192aa', brightWhite: '#ffffff',
  },
}

function rgbaFromAccent(accent, alpha) {
  // Turn the accent hex into an rgba() string for selection/cursor glows.
  const value = String(accent || '#4f8cff').trim()
  const match = value.match(/^#([0-9a-f]{6})$/i)
  if (!match) return value
  const int = parseInt(match[1], 16)
  return `rgba(${(int >> 16) & 255}, ${(int >> 8) & 255}, ${int & 255}, ${alpha})`
}

function buildTheme(config, accent, bgAlpha) {
  const palette = config.colorScheme === 'accent' ? PALETTES.classic : (PALETTES[config.colorScheme] || PALETTES.classic)
  const themed = config.colorScheme === 'accent'
    ? { ...palette, blue: accent, brightBlue: accent, cyan: accent, brightCyan: accent }
    : palette
  return {
    background: `rgba(8, 10, 14, ${bgAlpha})`,
    foreground: '#e8edf7',
    cursor: accent,
    cursorAccent: 'rgba(8, 10, 14, 0.9)',
    selectionBackground: rgbaFromAccent(accent, 0.35),
    selectionInactiveBackground: rgbaFromAccent(accent, 0.22),
    ...themed,
  }
}

/**
 * One terminal tab: an xterm.js surface wired to a node-pty session in the
 * main process. Stays mounted while its tab exists (scrollback survives tab
 * switches); the `active` prop drives fit/focus.
 */
export function TerminalView({ tab, active, config, accent, bgOpacity, connection, onTitleChange }) {
  const hostRef = useRef(null)
  const termRef = useRef(null)
  const fitRef = useRef(null)
  const ptyIdRef = useRef(null)
  const [status, setStatus] = useState('connecting') // connecting | running | exited | error
  const [exitInfo, setExitInfo] = useState(null)
  const [distros, setDistros] = useState([])
  const [distro, setDistro] = useState(tab.distro || '')
  const [generation, setGeneration] = useState(0)
  // The creation effect reads the distro through a ref so that distro
  // auto-detection updating the dropdown never restarts a running session;
  // a new distro applies on the next explicit restart.
  const distroRef = useRef(distro)
  distroRef.current = distro

  const isWsl = tab.shell === 'wsl'

  const copySelection = useCallback(() => {
    const term = termRef.current
    if (!term) return false
    const selection = term.getSelection()
    if (!selection) return false
    window.dshApp?.clipboardWrite?.(selection)
    return true
  }, [])

  const pasteFromClipboard = useCallback(async () => {
    const result = await window.dshApp?.clipboardRead?.()
    if (result?.ok && result.text && ptyIdRef.current) {
      window.dshApp.writePty(ptyIdRef.current, result.text)
    }
  }, [])

  // Create/destroy the xterm + pty pair for one generation.
  useEffect(() => {
    let cancelled = false
    let offData = null
    let offExit = null
    let resizeObserver = null
    const host = hostRef.current
    if (!host) return undefined

    setStatus('connecting')
    setExitInfo(null)

    const term = new Terminal({
      allowProposedApi: true,
      cursorStyle: config.cursorStyle,
      cursorBlink: config.cursorBlink,
      fontSize: config.fontSize,
      fontFamily: `${config.fontFamily}, Consolas, "Microsoft YaHei Mono", monospace`,
      scrollback: config.scrollback,
      theme: buildTheme(config, accent, bgOpacity),
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    term.open(host)
    try { fit.fit() } catch (_) { /* hidden container */ }

    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true
      const ctrl = event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey
      // Ctrl+C with a selection copies instead of sending SIGINT.
      if (ctrl && event.key.toLowerCase() === 'c' && term.hasSelection()) {
        copySelection()
        event.preventDefault()
        return false
      }
      // Ctrl+V pastes from the clipboard.
      if (ctrl && event.key.toLowerCase() === 'v') {
        pasteFromClipboard()
        event.preventDefault()
        return false
      }
      return true
    })

    // Select-to-copy and right-click paste, matching terminal conventions
    // (right-click copies when there is a selection, otherwise pastes).
    const onMouseUp = (event) => {
      if (event.button === 0) copySelection()
    }
    const onContextMenu = (event) => {
      event.preventDefault()
      if (!copySelection()) pasteFromClipboard()
    }
    host.addEventListener('mouseup', onMouseUp)
    host.addEventListener('contextmenu', onContextMenu)

    termRef.current = term
    fitRef.current = fit

    const startPty = async () => {
      // WSL accepts Linux paths; convert a Windows cwd with wslpath first,
      // falling back to the mechanical /mnt/<drive> mapping.
      let cwd = tab.cwd || connection?.cwd || ''
      if (isWsl && /^[A-Za-z]:[\\/]/.test(cwd)) {
        const converted = await window.dshApp?.wslPath?.({ distro: distroRef.current, path: cwd })
        if (converted?.ok && converted.path) {
          cwd = converted.path
        } else {
          const match = cwd.match(/^([A-Za-z]):[\\/](.*)$/)
          if (match) cwd = `/mnt/${match[1].toLowerCase()}/${match[2].replaceAll('\\', '/')}`
        }
      }
      if (cancelled) return
      const result = await window.dshApp.createPty({
        shell: tab.shell,
        distro: distroRef.current,
        cwd,
        cols: term.cols,
        rows: term.rows,
        connection,
      })
      if (cancelled) {
        if (result?.ok) window.dshApp.disposePty(result.id)
        return
      }
      if (!result?.ok) {
        setStatus('error')
        setExitInfo({ error: result?.error || '终端启动失败' })
        return
      }
      ptyIdRef.current = result.id
      setStatus('running')
      term.focus()

      offData = window.dshApp.onPtyData(({ id, data }) => {
        if (id === result.id) term.write(data)
      })
      offExit = window.dshApp.onPtyExit(({ id, code }) => {
        if (id !== result.id) return
        ptyIdRef.current = null
        setStatus('exited')
        setExitInfo({ code })
      })
      term.onData((data) => {
        if (ptyIdRef.current === result.id) window.dshApp.writePty(result.id, data)
      })
    }
    startPty()

    // Resize: fit to the container, then tell the pty. Guarded for hidden
    // tabs (display:none reports a zero box).
    let resizeScheduled = false
    const scheduleResize = () => {
      if (resizeScheduled) return
      resizeScheduled = true
      requestAnimationFrame(() => {
        resizeScheduled = false
        if (cancelled || host.clientWidth === 0 || host.clientHeight === 0) return
        try {
          fit.fit()
          if (ptyIdRef.current) window.dshApp.resizePty(ptyIdRef.current, term.cols, term.rows)
        } catch (_) { /* container vanished mid-frame */ }
      })
    }
    resizeObserver = new ResizeObserver(scheduleResize)
    resizeObserver.observe(host)

    return () => {
      cancelled = true
      resizeObserver?.disconnect()
      host.removeEventListener('mouseup', onMouseUp)
      host.removeEventListener('contextmenu', onContextMenu)
      offData?.()
      offExit?.()
      if (ptyIdRef.current) window.dshApp.disposePty(ptyIdRef.current)
      ptyIdRef.current = null
      term.dispose()
      if (termRef.current === term) termRef.current = null
      if (fitRef.current === fit) fitRef.current = null
    }
    // distro is intentionally read through distroRef: detecting or picking a
    // distro must not tear down a running session (it applies on restart).
  }, [tab.id, generation])

  // Live-apply personalization changes without restarting the pty session.
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.fontFamily = `${config.fontFamily}, Consolas, "Microsoft YaHei Mono", monospace`
    term.options.fontSize = config.fontSize
    term.options.cursorStyle = config.cursorStyle
    term.options.cursorBlink = config.cursorBlink
    term.options.scrollback = config.scrollback
    term.options.theme = buildTheme(config, accent, bgOpacity)
  }, [config, accent, bgOpacity])

  // Reactivate: re-fit (display:none collapsed the box) and take focus.
  useEffect(() => {
    if (!active) return
    const timer = setTimeout(() => {
      try { fitRef.current?.fit() } catch (_) { /* still hidden */ }
      if (ptyIdRef.current && termRef.current?.cols) {
        window.dshApp.resizePty(ptyIdRef.current, termRef.current.cols, termRef.current.rows)
      }
      termRef.current?.focus()
    }, 30)
    return () => clearTimeout(timer)
  }, [active])

  // Lazy distro auto-detection for WSL tabs.
  useEffect(() => {
    if (!isWsl || distros.length) return
    window.dshApp?.listDistros?.().then((result) => {
      if (!result?.ok) return
      setDistros(result.distros || [])
      setDistro((current) => current || tab.distro || result.defaultDistro || '')
    })
  }, [isWsl, distros.length, tab.distro])

  const restart = () => setGeneration((value) => value + 1)

  const restartLabel = status === 'error' ? '重试' : '重新启动'

  return (
    <div className="terminal-page">
      <div className="terminal-toolbar">
        <span className="terminal-toolbar-title">
          {isWsl ? `WSL${distro ? ` · ${distro}` : ''}` : tab.shell === 'powershell' ? 'PowerShell' : '本机终端'}
        </span>
        {isWsl && distros.length > 0 && (
          <select
            value={distro}
            disabled={status === 'running' || status === 'connecting'}
            onChange={(event) => setDistro(event.target.value)}
            title="选择 WSL 发行版（重启后生效）"
          >
            {distros.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        )}
        <span className="terminal-toolbar-spacer" />
        {status === 'running' && (
          <button onClick={() => termRef.current?.clear()} title="清屏（保留滚动历史）">清屏</button>
        )}
        <button onClick={restart} disabled={status === 'connecting'}>{restartLabel}</button>
      </div>
      <div className="terminal-host-wrap">
        <div ref={hostRef} className="terminal-host" />
        {status === 'exited' && (
          <div className="terminal-overlay">
            <span>会话已结束{typeof exitInfo?.code === 'number' ? `（code=${exitInfo.code}）` : ''}</span>
            <button className="primary" onClick={restart}>{restartLabel}</button>
          </div>
        )}
        {status === 'error' && (
          <div className="terminal-overlay">
            <span>{exitInfo?.error || '终端启动失败'}</span>
            <button className="primary" onClick={restart}>{restartLabel}</button>
          </div>
        )}
      </div>
    </div>
  )
}
