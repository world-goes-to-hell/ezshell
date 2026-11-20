import { useEffect, useState } from 'react'
import { RiExternalLinkLine, RiFileCopyLine, RiGlobalLine } from 'react-icons/ri'
import { copyToClipboard } from '../../lib/terminalClipboard'
import { toast } from '../../stores/toastStore'
import { TerminalContextMenu } from './TerminalContextMenu'
import { TERMINAL_WEB_LINK_EVENT, type TerminalWebLink } from './terminalWebLinks'

type Destination = 'internal' | 'external'

export function webLinkItems(href: string, open: (destination: Destination) => void) {
  return [
    { label: 'ezShell 브라우저에서 열기', icon: RiGlobalLine, onSelect: () => open('internal') },
    { label: '브라우저에서 열기', icon: RiExternalLinkLine, onSelect: () => open('external') },
    { label: '주소 복사', icon: RiFileCopyLine, onSelect: () => void copyToClipboard(href) }
  ]
}

async function openLink(href: string, destination: Destination) {
  try {
    const result = await window.electronAPI.browserReviewOpenLink(href, destination)
    if (!result.success) toast.error('열지 못했습니다', result.error)
  } catch {
    toast.error('열지 못했습니다', '브라우저에서 링크를 열 수 없습니다.')
  }
}

/** Shared by the main window's terminals and the detached SSH window. */
export function TerminalWebLinkMenu() {
  const [link, setLink] = useState<TerminalWebLink | null>(null)
  useEffect(() => {
    const onLink = (event: Event) => setLink((event as CustomEvent<TerminalWebLink>).detail)
    window.addEventListener(TERMINAL_WEB_LINK_EVENT, onLink)
    return () => window.removeEventListener(TERMINAL_WEB_LINK_EVENT, onLink)
  }, [])
  if (!link) return null
  return (
    <TerminalContextMenu
      key={`${link.x}:${link.y}:${link.href}`}
      position={link}
      target={{
        name: link.href,
        hint: '웹 주소',
        items: webLinkItems(link.href, destination => void openLink(link.href, destination))
      }}
      top={[]}
      groups={[]}
      onClose={() => setLink(null)}
    />
  )
}
