import { useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  RiCloseLine, RiCloseFill, RiArrowLeftLine, RiArrowRightLine,
  RiFileCopyLine, RiEditLine, RiSplitCellsHorizontal,
  RiSplitCellsVertical, RiRecordCircleLine, RiStopCircleLine, RiFolderOpenLine, RiMergeCellsHorizontal
} from 'react-icons/ri'
import type { MergeChoice } from '../../lib/tabMerge'
import './TabContextMenu.css'

interface TabContextMenuProps {
  isOpen: boolean
  position: { x: number; y: number }
  tabId: string
  onClose: () => void
  onCloseTab: () => void
  onCloseOthers: () => void
  onCloseToLeft: () => void
  onCloseToRight: () => void
  onDuplicate: () => void
  onRename: () => void
  onSplitHorizontal: () => void
  onSplitVertical: () => void
  /** Whether this tab's terminal output is being written to a log file */
  isLogging: boolean
  onToggleLog: () => void
  onOpenLogFolder: () => void
  /** False for a DB tab: no duplicate or log items */
  isTerminal?: boolean
  /** Other tabs of the same session this tab can become a pane of (lib/tabMerge.ts); absent for a DB tab */
  mergeChoices?: MergeChoice[]
  /** A choice was picked; a blocked one is passed too, so the reason can be told */
  onMergeInto?: (choice: MergeChoice) => void
}

interface MenuEntry {
  type?: string
  icon?: typeof RiCloseLine
  label?: string
  action?: () => void
  /** Shown dimmed, with the reason as its tooltip (it can still be picked: the reason is then told) */
  dimmed?: boolean
  title?: string
}

export function TabContextMenu({
  isOpen, position, onClose,
  onCloseTab, onCloseOthers, onCloseToLeft, onCloseToRight,
  onDuplicate, onRename, onSplitHorizontal, onSplitVertical,
  isLogging, onToggleLog, onOpenLogFolder, isTerminal = true, mergeChoices, onMergeInto
}: TabContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside)
    }
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isOpen, onClose])

  // "칸으로 병합": one item per tab of the same session. With none, one dimmed item says why.
  const mergeItems: MenuEntry[] = !mergeChoices ? [] : mergeChoices.length === 0
    ? [{ icon: RiMergeCellsHorizontal, label: '다른 탭의 칸으로 병합', dimmed: true, title: '같은 세션에서 연 다른 탭이 없습니다' }]
    : mergeChoices.map(choice => ({
        icon: RiMergeCellsHorizontal,
        label: `칸으로 병합: ${choice.label}`,
        action: () => onMergeInto?.(choice),
        dimmed: choice.blocked !== null,
        title: choice.blocked ?? '이 탭의 셸을 그대로 그 탭의 칸으로 옮깁니다'
      }))

  const menuItems: MenuEntry[] = [
    { icon: RiCloseLine, label: '탭 닫기', action: onCloseTab },
    { icon: RiCloseFill, label: '다른 탭 닫기', action: onCloseOthers },
    { icon: RiArrowLeftLine, label: '왼쪽 탭 닫기', action: onCloseToLeft },
    { icon: RiArrowRightLine, label: '오른쪽 탭 닫기', action: onCloseToRight },
    { type: 'separator' },
    // A DB tab has no shell to duplicate or log
    ...(isTerminal ? [{ icon: RiFileCopyLine, label: '탭 복제', action: onDuplicate }] : []),
    { icon: RiEditLine, label: '탭 이름 변경', action: onRename },
    { type: 'separator' },
    { icon: RiSplitCellsHorizontal, label: '가로 분할', action: onSplitHorizontal },
    { icon: RiSplitCellsVertical, label: '세로 분할', action: onSplitVertical },
    ...(mergeItems.length > 0 ? [{ type: 'separator' }, ...mergeItems] : []),
    ...(isTerminal ? [
      { type: 'separator' },
      isLogging
        ? { icon: RiStopCircleLine, label: '로그 저장 중지', action: onToggleLog }
        : { icon: RiRecordCircleLine, label: '로그 저장 시작', action: onToggleLog },
      { icon: RiFolderOpenLine, label: '로그 폴더 열기', action: onOpenLogFolder }
    ] : []),
  ]

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          ref={menuRef}
          className="tab-context-menu"
          style={{ left: position.x, top: position.y }}
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.95 }}
        >
          {menuItems.map((item, index) =>
            item.type === 'separator' ? (
              <div key={index} className="menu-separator" />
            ) : (
              <button key={index} className={`menu-item${item.dimmed ? ' is-dimmed' : ''}`} title={item.title} onClick={() => { item.action?.(); onClose(); }}>
                {item.icon && <item.icon size={16} />}
                <span>{item.label}</span>
              </button>
            )
          )}
        </motion.div>
      )}
    </AnimatePresence>
  )
}
