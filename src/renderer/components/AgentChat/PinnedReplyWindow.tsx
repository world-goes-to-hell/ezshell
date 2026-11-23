// An agent answer pinned out of the chat view, in a small window of its own (docs/plan/2026-11-20-pinned-agent-replies.md,
// design mockups/pinned-reply-window.html). Read while working in another tab: the text is the answer as
// it was pinned, kept by main in memory. Links open through main, only the ones this answer had.
import { useEffect, useMemo, useState, type MouseEvent } from 'react'
import { RiAddLine, RiArrowGoBackLine, RiCheckboxBlankLine, RiCheckboxMultipleBlankLine, RiCloseLine, RiFileCopyLine, RiFileTextLine, RiFolderOpenLine, RiSubtractLine } from 'react-icons/ri'
import type { PinnedReply } from '../../types'
import { usePopoutTheme } from '../../hooks/usePopoutTheme'
import { LOCAL_PATH_LINK, renderChatMarkdown } from '../../lib/markdownRender'
import { copyToClipboard } from '../../lib/terminalClipboard'
import { TerminalContextMenu } from '../Terminal/TerminalContextMenu'
import { webLinkItems } from '../Terminal/TerminalWebLinkMenu'
import { AGENT_PROVIDER_ICONS, AGENT_PROVIDER_NAMES } from '../ui/agentProviderIcons'
import { useThemeStore } from '../../stores/themeStore'
import { toast } from '../../stores/toastStore'
import { chatAppearance } from '../../themes/chatThemes'
import './AgentChat.css'
import './PinnedReplyWindow.css'


interface LinkMenu {
  x: number
  y: number
  href: string
  isFile: boolean
}

const clock = (time: number) => new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

export function PinnedReplyWindow() {
  usePopoutTheme()
  const chatThemeId = useThemeStore(state => state.chatThemeId)
  const customThemes = useThemeStore(state => state.customThemes)
  const appearance = useMemo(() => chatAppearance(chatThemeId, customThemes), [chatThemeId, customThemes])
  const [pin, setPin] = useState<PinnedReply | null>(null)
  const [error, setError] = useState('')
  const [folded, setFolded] = useState(false)
  const [maximized, setMaximized] = useState(false)
  const [linkMenu, setLinkMenu] = useState<LinkMenu | null>(null)
  const api = window.electronAPI

  useEffect(() => {
    let alive = true
    let receivedMaximizedState = false
    const off = api.onPinnedReplyMaximized?.(value => {
      receivedMaximizedState = true
      setMaximized(value)
    })
    void api.pinnedReplyGet?.().then(result => {
      if (!alive) return
      if (result.ok) {
        setPin(result.pin)
        setFolded(result.pin.folded)
        if (!receivedMaximizedState) setMaximized(result.pin.maximized)
      } else {
        setError(result.error)
      }
    }).catch(() => { if (alive) setError('띄운 답변을 불러오지 못했습니다.') })
    return () => { alive = false; off?.() }
  }, [api])

  useEffect(() => {
    if (pin) document.title = `${pin.title} · 띄운 답변`
  }, [pin])

  // Inert HTML from markdownRender (html: false, links checked, no images), as in the chat view
  const html = useMemo(() => (pin ? renderChatMarkdown(pin.text) : ''), [pin])

  const toggleFold = () => {
    const next = !folded
    setFolded(next)
    setLinkMenu(null)
    api.pinnedReplyFold?.(next)
  }

  const onBodyClick = (event: MouseEvent<HTMLDivElement>) => {
    const link = (event.target as HTMLElement).closest('a')
    if (!link) return
    event.preventDefault()
    const href = link.getAttribute('href') ?? ''
    if (!href || href.startsWith('#') || /^mailto:/i.test(href)) return
    setLinkMenu({ x: event.clientX, y: event.clientY, href, isFile: LOCAL_PATH_LINK.test(href) })
  }

  const openLink = async (href: string, how: 'app' | 'explorer' | 'browser' | 'browser-tab') => {
    try {
      const result = await api.pinnedReplyOpenLink?.(href, how)
      if (!result?.ok) toast.error('열지 못했습니다', result && !result.ok ? result.error : '이 앱 버전에서는 쓸 수 없습니다.')
    } catch {
      toast.error('열지 못했습니다', '링크를 열 수 없습니다.')
    }
  }

  const linkMenuItems = (menu: LinkMenu) => menu.isFile && /[\\/]$/.test(menu.href)
    // A folder (`docs/plan/`): main opens it in the file manager
    ? [
        { label: '폴더 열기', icon: RiFolderOpenLine, onSelect: () => void openLink(menu.href, 'app') },
        { label: '경로 복사', icon: RiFileCopyLine, onSelect: () => void copyToClipboard(menu.href) }
      ]
    : menu.isFile
    ? [
        { label: 'ezShell 에서 열기', icon: RiFileTextLine, onSelect: () => void openLink(menu.href, 'app') },
        { label: '파일 탐색기에서 열기', icon: RiFolderOpenLine, onSelect: () => void openLink(menu.href, 'explorer') },
        { label: '경로 복사', icon: RiFileCopyLine, onSelect: () => void copyToClipboard(menu.href) }
      ]
    : webLinkItems(menu.href, destination => void openLink(menu.href, destination === 'internal' ? 'browser-tab' : 'browser'))

  const kind = pin?.kind ?? null
  const agentName = kind === 'claude' ? 'Claude' : kind ? AGENT_PROVIDER_NAMES[kind] : undefined
  const ProviderIcon = kind ? AGENT_PROVIDER_ICONS[kind] : null
  const time = pin ? clock(pin.time ?? pin.pinnedAt) : ''
  const maximizeLabel = maximized ? '이전 크기로 복원' : '최대화'
  const linkName = (menu: LinkMenu) => {
    if (!menu.isFile) return menu.href
    const plain = menu.href.replace(/^file:\/\/\//i, '').replace(/[\\/]+$/, '')
    return plain.split(/[\\/]/).pop() || plain
  }

  return (
    <div className="pinned-reply" data-folded={folded ? 'true' : undefined}
      data-chat-bubbles={appearance?.bubbles || undefined} style={appearance?.style}>
      <header className="pinned-reply-head">
        <span className="pinned-reply-drag" aria-hidden="true">⋮⋮</span>
        {ProviderIcon && kind && (
          <span className="pinned-reply-kind" data-kind={kind} title={agentName}>
            <ProviderIcon size={14} aria-label={agentName} />
          </span>
        )}
        <span className="pinned-reply-title" title={pin?.title}>{pin?.title ?? '띄운 답변'}</span>
        {time && <time className="pinned-reply-time">{time}</time>}
        <div className="pinned-reply-actions">
          <button type="button" className="pinned-reply-btn" data-action="source" title="원래 대화로 가기" aria-label="원래 대화로 가기"
            onClick={() => api.pinnedReplyGo?.()} disabled={!pin}>
            <RiArrowGoBackLine aria-hidden />
          </button>
          <button type="button" className="pinned-reply-btn" data-action="fold" title={folded ? '펼치기' : '접기'} aria-label={folded ? '펼치기' : '접기'}
            aria-expanded={!folded} onClick={toggleFold}>
            {folded ? <RiAddLine aria-hidden /> : <RiSubtractLine aria-hidden />}
          </button>
          <button type="button" className="pinned-reply-btn" data-action="maximize" title={maximizeLabel} aria-label={maximizeLabel}
            onClick={() => api.maximizeWindow()} disabled={!pin || folded}>
            {maximized ? <RiCheckboxMultipleBlankLine aria-hidden /> : <RiCheckboxBlankLine aria-hidden />}
          </button>
          <button type="button" className="pinned-reply-btn" data-action="close" title="닫기" aria-label="닫기" onClick={() => api.closeWindow()}>
            <RiCloseLine aria-hidden />
          </button>
        </div>
      </header>
      {!folded && (
        <div className="pinned-reply-body" tabIndex={0} role="group" aria-label="답변 본문" onClick={onBodyClick}>
          {error
            ? <p className="pinned-reply-empty">{error}</p>
            : pin
              ? <div className="pinned-reply-message agent-chat-md" dangerouslySetInnerHTML={{ __html: html }} />
              : <p className="pinned-reply-empty">불러오는 중…</p>}
        </div>
      )}
      {linkMenu && (
        <TerminalContextMenu
          key={`${linkMenu.x}:${linkMenu.y}`}
          position={linkMenu}
          target={{ name: linkName(linkMenu), hint: linkMenu.isFile ? '이 PC' : '웹 주소', items: linkMenuItems(linkMenu) }}
          top={[]}
          groups={[]}
          onClose={() => setLinkMenu(null)}
        />
      )}
    </div>
  )
}
