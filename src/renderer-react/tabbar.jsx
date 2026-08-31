import React, { useRef, useState } from 'react'
import { createPortal } from 'react-dom'

const TAB_ICON = { dsh: '✦', terminal: '>_' }

/**
 * Firefox-style tab strip: rounded tabs, hover-revealed close buttons,
 * drag-to-reorder, middle-click close, automatic compression and horizontal
 * scrolling when tabs overflow the available width.
 */
export function TabBar({ tabs, activeTabId, onSelect, onClose, onReorder }) {
  const [dragIndex, setDragIndex] = useState(null)
  const stripRef = useRef(null)

  const handleDragStart = (event, index) => {
    setDragIndex(index)
    event.dataTransfer.effectAllowed = 'move'
    // Firefox needs a drag image; the default (the tab itself) is fine.
  }

  const handleDragEnter = (index) => {
    if (dragIndex === null || dragIndex === index) return
    onReorder(dragIndex, index)
    setDragIndex(index)
  }

  const handleDragEnd = () => setDragIndex(null)

  // Vertical wheel over the strip scrolls it horizontally. No preventDefault:
  // React registers wheel listeners as passive, and the page itself cannot
  // scroll (overflow hidden).
  const handleWheel = (event) => {
    if (stripRef.current && event.deltaY) {
      stripRef.current.scrollLeft += event.deltaY
    }
  }

  return (
    <div className="tabbar" ref={stripRef} onWheel={handleWheel} role="tablist">
      {tabs.map((tab, index) => {
        const isActive = tab.id === activeTabId
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={isActive}
            className={`tab ${isActive ? 'active' : ''} ${dragIndex === index ? 'dragging' : ''}`}
            draggable
            title={tab.title}
            onClick={() => onSelect(tab.id)}
            onMouseDown={(event) => {
              // Middle-click closes, like Firefox.
              if (event.button === 1) {
                event.preventDefault()
                onClose(tab.id)
              }
            }}
            onDragStart={(event) => handleDragStart(event, index)}
            onDragEnter={() => handleDragEnter(index)}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => event.preventDefault()}
            onDragEnd={handleDragEnd}
          >
            <span className="tab-icon" aria-hidden="true">{TAB_ICON[tab.type] || '✦'}</span>
            <span className="tab-label">{tab.title}</span>
            <button
              className="tab-close"
              title="关闭标签页"
              onClick={(event) => {
                event.stopPropagation()
                onClose(tab.id)
              }}
            >
              ✕
            </button>
          </div>
        )
      })}
    </div>
  )
}

/**
 * The "+" new-tab popover: choose between a dsh page tab and a terminal tab.
 *
 * Rendered through a portal onto document.body. The tab strip uses
 * backdrop-filter, which makes it the containing block for any fixed/absolute
 * descendant — a popover positioned inside it can neither escape the strip's
 * box nor cover the page as a click-catcher. At body level the backdrop spans
 * the viewport and the menu is anchored to the "+" button's rect, staying
 * above the dsh shell regardless of the shell's own stacking.
 */
export function NewTabMenu({ open, anchorRect, onPick, onClose }) {
  if (!open) return null
  const menuStyle = anchorRect
    ? { top: anchorRect.bottom + 6, right: Math.max(8, window.innerWidth - anchorRect.right) }
    : undefined
  return createPortal(
    <>
      <div className="newtab-backdrop" onPointerDown={onClose} />
      <div className="newtab-menu" role="menu" style={menuStyle}>
        <button role="menuitem" onClick={() => onPick('dsh')}>
          <span className="newtab-icon" aria-hidden="true">✦</span>
          <span>
            <strong>dsh 页面</strong>
            <small>DeepSeek Harness Web Shell</small>
          </span>
        </button>
        <button role="menuitem" onClick={() => onPick('terminal')}>
          <span className="newtab-icon" aria-hidden="true">&gt;_</span>
          <span>
            <strong>终端</strong>
            <small>WSL / 本机伪终端（xterm）</small>
          </span>
        </button>
      </div>
    </>,
    document.body,
  )
}
