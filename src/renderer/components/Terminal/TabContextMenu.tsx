import { useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  RiCloseLine, RiCloseFill, RiArrowRightLine,
  RiFileCopyLine, RiEditLine, RiSplitCellsHorizontal,
  RiSplitCellsVertical
} from 'react-icons/ri'
import './TabContextMenu.css'

interface TabContextMenuProps {
  isOpen: boolean
  position: { x: number; y: number }
  tabId: string
  onClose: () => void
  onCloseTab: () => void
  onCloseOthers: () => void
  onCloseToRight: () => void
  onDuplicate: () => void
  onRename: () => void
  onSplitHorizontal: () => void
  onSplitVertical: () => void
}

export function TabContextMenu({
  isOpen, position, onClose,
  onCloseTab, onCloseOthers, onCloseToRight,
  onDuplicate, onRename, onSplitHorizontal, onSplitVertical
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

  const menuItems = [
    { icon: RiCloseLine, label: '탭 닫기', action: onCloseTab },
    { icon: RiCloseFill, label: '다른 탭 닫기', action: onCloseOthers },
    { icon: RiArrowRightLine, label: '오른쪽 탭 닫기', action: onCloseToRight },
    { type: 'separator' },
    { icon: RiFileCopyLine, label: '탭 복제', action: onDuplicate },
    { icon: RiEditLine, label: '탭 이름 변경', action: onRename },
    { type: 'separator' },
    { icon: RiSplitCellsHorizontal, label: '가로 분할', action: onSplitHorizontal },
    { icon: RiSplitCellsVertical, label: '세로 분할', action: onSplitVertical },
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
              <button key={index} className="menu-item" onClick={() => { item.action?.(); onClose(); }}>
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
