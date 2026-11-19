import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { RiArrowRightSLine, RiCheckLine, RiFolder3Line, RiLinksLine } from 'react-icons/ri'
import { useLocalProjects } from '../../hooks/useLocalProjects'
import { useProjectServers } from '../../hooks/useProjectServers'
import { linkServer, projectKeyOf, readProjectServers, unlinkServer, writeProjectServers } from '../../lib/localProjectServers'
import { placeSidePanel, type SidePanelPlacement } from '../../lib/sidePanelPlacement'
import { buildProjectNodes } from './LocalProjectsTree'
import './MoveToFolderSubmenu.css'

const CLOSE_DELAY_MS = 150

/** The registered local projects, each ticked when the session is linked to it; a press links or unlinks */
function ProjectChoices({ sessionId }: { sessionId: string }) {
  // Git is asked only while this list is open
  const { projects } = useLocalProjects()
  const nodes = useMemo(() => buildProjectNodes(projects), [projects])
  const servers = useProjectServers()
  if (nodes.length === 0) return <div className="folder-move-title">로컬 작업에 등록한 폴더가 없습니다</div>
  return (
    <>
      <div className="folder-move-title">묶을 로컬 프로젝트</div>
      {nodes.map(project => {
        const key = projectKeyOf(project)
        const isLinked = (servers[key] ?? []).includes(sessionId)
        return (
          <div
            key={key}
            className="context-menu-item"
            role="menuitemcheckbox"
            aria-checked={isLinked}
            title={project.folder}
            onClick={() => {
              const current = readProjectServers()
              writeProjectServers(isLinked ? unlinkServer(current, key, sessionId) : linkServer(current, key, sessionId))
            }}
          >
            <RiFolder3Line size={16} />
            <span>{project.name}</span>
            {isLinked && <RiCheckLine size={16} className="context-menu-check" />}
          </div>
        )
      })}
    </>
  )
}

/**
 * "로컬 작업에 묶기 ›" in a session's context menu: the session shows under the picked project in the
 * sidebar's local tree ("서버"). Same side panel as "폴더로 이동".
 */
export function LinkToProjectSubmenu({ sessionId }: { sessionId: string }) {
  const [isOpen, setIsOpen] = useState(false)
  const [placement, setPlacement] = useState<SidePanelPlacement | null>(null)
  const anchorRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useLayoutEffect(() => {
    const anchorEl = anchorRef.current
    const panelEl = panelRef.current
    if (!isOpen || !anchorEl || !panelEl) {
      setPlacement(null)
      return
    }
    const place = () => setPlacement(placeSidePanel(
      anchorEl.getBoundingClientRect(),
      { width: panelEl.offsetWidth, height: panelEl.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight }
    ))
    place()
    // The project list fills in as Git answers
    const observer = new ResizeObserver(place)
    observer.observe(panelEl)
    return () => observer.disconnect()
  }, [isOpen])

  const open = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
    setIsOpen(true)
  }
  const scheduleClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => setIsOpen(false), CLOSE_DELAY_MS)
  }

  return (
    <div className="folder-move" ref={anchorRef} onMouseEnter={open} onMouseLeave={scheduleClose}>
      <div
        className={`context-menu-item folder-move-trigger ${isOpen ? 'is-open' : ''}`}
        role="menuitem"
        aria-haspopup="true"
        aria-expanded={isOpen}
        onClick={event => { event.stopPropagation(); setIsOpen(prev => !prev) }}
      >
        <RiLinksLine size={16} />
        <span>로컬 작업에 묶기</span>
        <RiArrowRightSLine size={16} className="folder-move-chevron" />
      </div>
      {isOpen && (
        <div
          ref={panelRef}
          className="folder-move-panel"
          style={placement ? { left: placement.left, top: placement.top, maxHeight: `min(420px, 70vh, ${placement.maxHeight}px)` } : { visibility: 'hidden' }}
          role="menu"
          aria-label="묶을 로컬 프로젝트"
          onMouseEnter={open}
        >
          <ProjectChoices sessionId={sessionId} />
        </div>
      )}
    </div>
  )
}
