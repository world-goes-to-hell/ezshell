import { useEffect, useMemo, useState } from 'react'
import { motion, AnimatePresence, type Variants } from 'framer-motion'
import { RiSearchLine, RiTerminalLine, RiServerLine, RiNavigationLine, RiAppsLine, RiRestartLine, RiEditLine } from 'react-icons/ri'
import { useShortcutsStore, ShortcutCategory } from '../../stores/shortcutsStore'
import { useReducedMotion } from '../../hooks/useReducedMotion'
import { confirmDialog } from '../../stores/confirmStore'
import { bindingProblemFor, captureKeys, findConflict } from '../../lib/shortcutCapture'
import { isMac, shortcutKeyLabels } from '../../lib/shortcutModifiers'
import './ShortcutsPanel.css'

const categoryIcons: Record<ShortcutCategory, React.ComponentType<{ size?: number }>> = {
  general: RiAppsLine,
  terminal: RiTerminalLine,
  sftp: RiServerLine,
  navigation: RiNavigationLine
}

const categoryLabels: Record<ShortcutCategory, string> = {
  general: '일반',
  terminal: '터미널',
  sftp: 'SFTP',
  navigation: '탭 이동'
}

/**
 * The app's shortcuts: press the keys shown for an editable shortcut, then the new
 * combination. Esc cancels. A combination another shortcut uses, or one the system needs, is refused
 * with the reason (lib/shortcutCapture.ts).
 */
export function ShortcutsPanel() {
  const { shortcuts, getEffectiveKeys, customBindings, setCustomBinding, resetCustomBinding } = useShortcutsStore()
  const [searchQuery, setSearchQuery] = useState('')
  // The shortcut whose new keys are being recorded, and why the last press was refused
  const [recordingId, setRecordingId] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const reducedMotion = useReducedMotion()
  const onMac = isMac()

  const filteredShortcuts = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    if (!query) return shortcuts
    return shortcuts.filter((shortcut) => {
      const keys = shortcutKeyLabels(customBindings[shortcut.id] ?? shortcut.keys, onMac).join('+').toLowerCase()
      return shortcut.description.toLowerCase().includes(query) || categoryLabels[shortcut.category].toLowerCase().includes(query) || keys.includes(query)
    })
  }, [shortcuts, searchQuery, customBindings, onMac])

  const groupedShortcuts = useMemo(() => {
    const groups: Record<ShortcutCategory, typeof shortcuts> = { general: [], terminal: [], sftp: [], navigation: [] }
    filteredShortcuts.forEach(shortcut => { groups[shortcut.category].push(shortcut) })
    return groups
  }, [filteredShortcuts])

  // While recording, every key press belongs to this panel: it must not run a shortcut, type into
  // the search box or close the settings. Capture phase, before the app's own shortcut handler.
  useEffect(() => {
    if (!recordingId) return
    window.electronAPI.setShortcutRecording?.(true)
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault()
      event.stopImmediatePropagation()
      if (event.key === 'Escape') {
        setRecordingId(null)
        setProblem(null)
        return
      }
      const captured = captureKeys(event, onMac)
      if (captured.kind === 'waiting') return
      if (captured.kind === 'invalid') {
        setProblem(captured.reason)
        return
      }
      // Rules of this shortcut itself (the work overview is taken outside the app too)
      const own = bindingProblemFor(recordingId, captured.keys, onMac)
      if (own) {
        setProblem(own)
        return
      }
      const state = useShortcutsStore.getState()
      const conflict = findConflict(state.shortcuts, state.customBindings, recordingId, captured.keys)
      if (conflict) {
        setProblem(`이미 '${conflict.description}' 에 쓰고 있습니다. 그쪽을 먼저 바꾸거나 다른 키를 눌러 주세요.`)
        return
      }
      const shortcut = state.shortcuts.find(item => item.id === recordingId)
      // The default again: no custom binding needs to be kept
      if (shortcut && shortcut.keys.join('+') === captured.keys.join('+')) resetCustomBinding(recordingId)
      else setCustomBinding(recordingId, captured.keys)
      setRecordingId(null)
      setProblem(null)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.electronAPI.setShortcutRecording?.(false)
    }
  }, [recordingId, onMac, setCustomBinding, resetCustomBinding])

  const hasCustomBindings = Object.keys(customBindings).length > 0

  const handleResetAll = async () => {
    const confirmed = await confirmDialog({
      title: '단축키 초기화',
      message: `직접 바꾼 단축키 ${Object.keys(customBindings).length}개를 모두 기본값으로 되돌립니다.`,
      confirmLabel: '초기화',
      danger: true
    })
    if (confirmed) Object.keys(customBindings).forEach(id => resetCustomBinding(id))
  }

  const startRecording = (id: string) => {
    setProblem(null)
    setRecordingId(current => (current === id ? null : id))
  }

  const renderKeys = (keys: string[]) => {
    const labels = shortcutKeyLabels(keys, onMac)
    return (
      <span className="shortcut-keys">
        {labels.map((label, index) => (
          <span key={index}>
            <kbd className="shortcut-key">{label}</kbd>
            {index < labels.length - 1 && <span className="shortcut-plus">+</span>}
          </span>
        ))}
      </span>
    )
  }

  const listVariants: Variants = reducedMotion ? {} : { hidden: { opacity: 0 }, visible: { opacity: 1, transition: { staggerChildren: 0.02 } } }
  const itemVariants: Variants = reducedMotion ? {} : { hidden: { opacity: 0, y: -5 }, visible: { opacity: 1, y: 0 } }

  return (
    <div className="shortcuts-panel">
      <div className="shortcuts-search">
        <RiSearchLine size={18} className="shortcuts-search-icon" />
        <input
          type="text"
          className="shortcuts-search-input"
          placeholder="단축키 찾기 (이름이나 키)"
          aria-label="단축키 찾기"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
        {hasCustomBindings && (
          <button className="shortcuts-reset-all-btn" onClick={() => void handleResetAll()} title="직접 바꾼 단축키를 모두 기본값으로 되돌립니다">
            <RiRestartLine size={16} />
            모두 초기화
          </button>
        )}
      </div>

      <p className="shortcuts-hint">
        단축키를 누르면 바꿀 수 있습니다. 새 키 조합을 누르면 저장되고, <kbd>Esc</kbd> 로 취소합니다.
        {onMac ? ' Mac 에서는 Command(⌘) 키와 함께 씁니다.' : ''}
      </p>

      <div className="shortcuts-list">
        {(Object.keys(groupedShortcuts) as ShortcutCategory[]).map(category => {
          const categoryShortcuts = groupedShortcuts[category]
          if (categoryShortcuts.length === 0) return null
          const Icon = categoryIcons[category]

          return (
            <motion.div key={category} className="shortcuts-category" variants={listVariants} initial="hidden" animate="visible">
              <div className="shortcuts-category-header">
                <Icon size={18} />
                <h4>{categoryLabels[category]}</h4>
                <span className="shortcuts-category-count">{categoryShortcuts.length}</span>
              </div>

              <AnimatePresence mode="popLayout">
                {categoryShortcuts.map(shortcut => {
                  const effectiveKeys = getEffectiveKeys(shortcut.id)
                  const isCustom = customBindings[shortcut.id] !== undefined
                  const isRecording = recordingId === shortcut.id

                  return (
                    <motion.div
                      key={shortcut.id}
                      className={`shortcut-item ${isCustom ? 'custom' : ''}${isRecording ? ' is-recording' : ''}`}
                      variants={itemVariants}
                      layout={!reducedMotion}
                    >
                      <div className="shortcut-info">
                        <div className="shortcut-description">{shortcut.description}</div>
                        {shortcut.note && <div className="shortcut-action">{shortcut.note}</div>}
                        {isCustom && <div className="shortcut-action">직접 바꿈 · 기본값 {shortcutKeyLabels(shortcut.keys, onMac).join('+')}</div>}
                        {isRecording && problem && <div className="shortcut-problem" role="alert">{problem}</div>}
                      </div>

                      <div className="shortcut-binding">
                        {shortcut.fixed ? renderKeys(effectiveKeys) : <button
                          type="button"
                          className={`shortcut-change-btn${isRecording ? ' is-recording' : ''}`}
                          onClick={() => startRecording(shortcut.id)}
                          aria-label={`${shortcut.description} 단축키 바꾸기`}
                          title={isRecording ? '취소하려면 다시 누르거나 Esc' : '눌러서 단축키 바꾸기'}
                        >
                          {isRecording ? <span className="shortcut-recording">새 키를 누르세요…</span> : <>{renderKeys(effectiveKeys)}<RiEditLine size={14} className="shortcut-edit-icon" /></>}
                        </button>}
                        {isCustom && !isRecording && (
                          <button className="shortcut-reset-btn" onClick={() => resetCustomBinding(shortcut.id)} title="기본값으로 되돌리기" aria-label="기본값으로 되돌리기">
                            <RiRestartLine size={16} />
                          </button>
                        )}
                      </div>
                    </motion.div>
                  )
                })}
              </AnimatePresence>
            </motion.div>
          )
        })}
      </div>

      {filteredShortcuts.length === 0 && (
        <div className="shortcuts-empty">
          <RiSearchLine size={32} />
          <p>찾는 단축키가 없습니다</p>
        </div>
      )}
    </div>
  )
}
