import { useState, useMemo } from 'react'
import { motion, AnimatePresence, type Variants } from 'framer-motion'
import { RiSearchLine, RiTerminalLine, RiServerLine, RiNavigationLine, RiAppsLine, RiRestartLine } from 'react-icons/ri'
import { useShortcutsStore, ShortcutCategory } from '../../stores/shortcutsStore'
import { useReducedMotion } from '../../hooks/useReducedMotion'
import './ShortcutsPanel.css'

const categoryIcons: Record<ShortcutCategory, React.ComponentType<{ size?: number }>> = {
  general: RiAppsLine,
  terminal: RiTerminalLine,
  sftp: RiServerLine,
  navigation: RiNavigationLine
}

const categoryLabels: Record<ShortcutCategory, string> = {
  general: 'General',
  terminal: 'Terminal',
  sftp: 'SFTP',
  navigation: 'Navigation'
}

export function ShortcutsPanel() {
  const { shortcuts, formatKeys, getEffectiveKeys, customBindings, resetCustomBinding } = useShortcutsStore()
  const [searchQuery, setSearchQuery] = useState('')
  const reducedMotion = useReducedMotion()

  // Filter shortcuts by search query
  const filteredShortcuts = useMemo(() => {
    if (!searchQuery.trim()) return shortcuts

    const query = searchQuery.toLowerCase()
    return shortcuts.filter(
      shortcut =>
        shortcut.description.toLowerCase().includes(query) ||
        shortcut.category.toLowerCase().includes(query) ||
        formatKeys(shortcut.keys).toLowerCase().includes(query)
    )
  }, [shortcuts, searchQuery, formatKeys])

  // Group shortcuts by category
  const groupedShortcuts = useMemo(() => {
    const groups: Record<ShortcutCategory, typeof shortcuts> = {
      general: [],
      terminal: [],
      sftp: [],
      navigation: []
    }

    filteredShortcuts.forEach(shortcut => {
      groups[shortcut.category].push(shortcut)
    })

    return groups
  }, [filteredShortcuts])

  const hasCustomBindings = Object.keys(customBindings).length > 0

  const handleResetAll = () => {
    if (confirm('Reset all keyboard shortcuts to defaults?')) {
      Object.keys(customBindings).forEach(id => resetCustomBinding(id))
    }
  }

  const renderKeys = (keys: string[]) => {
    return (
      <div className="shortcut-keys">
        {keys.map((key, index) => (
          <span key={index}>
            <kbd className="shortcut-key">{key}</kbd>
            {index < keys.length - 1 && <span className="shortcut-plus">+</span>}
          </span>
        ))}
      </div>
    )
  }

  const listVariants: Variants = reducedMotion
    ? {}
    : {
        hidden: { opacity: 0 },
        visible: {
          opacity: 1,
          transition: {
            staggerChildren: 0.02
          }
        }
      }

  const itemVariants: Variants = reducedMotion
    ? {}
    : {
        hidden: { opacity: 0, y: -5 },
        visible: { opacity: 1, y: 0 }
      }

  return (
    <div className="shortcuts-panel">
      {/* Search Bar */}
      <div className="shortcuts-search">
        <RiSearchLine size={18} className="shortcuts-search-icon" />
        <input
          type="text"
          className="shortcuts-search-input"
          placeholder="Search shortcuts..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
        {hasCustomBindings && (
          <button
            className="shortcuts-reset-all-btn"
            onClick={handleResetAll}
            title="Reset all shortcuts to defaults"
          >
            <RiRestartLine size={16} />
            Reset All
          </button>
        )}
      </div>

      {/* Shortcuts List */}
      <div className="shortcuts-list">
        {(Object.keys(groupedShortcuts) as ShortcutCategory[]).map(category => {
          const categoryShortcuts = groupedShortcuts[category]
          if (categoryShortcuts.length === 0) return null

          const Icon = categoryIcons[category]

          return (
            <motion.div
              key={category}
              className="shortcuts-category"
              variants={listVariants}
              initial="hidden"
              animate="visible"
            >
              <div className="shortcuts-category-header">
                <Icon size={18} />
                <h4>{categoryLabels[category]}</h4>
                <span className="shortcuts-category-count">{categoryShortcuts.length}</span>
              </div>

              <AnimatePresence mode="popLayout">
                {categoryShortcuts.map(shortcut => {
                  const effectiveKeys = getEffectiveKeys(shortcut.id)
                  const isCustom = customBindings[shortcut.id] !== undefined

                  return (
                    <motion.div
                      key={shortcut.id}
                      className={`shortcut-item ${isCustom ? 'custom' : ''}`}
                      variants={itemVariants}
                      layout={!reducedMotion}
                    >
                      <div className="shortcut-info">
                        <div className="shortcut-description">{shortcut.description}</div>
                        <div className="shortcut-action">{shortcut.action}</div>
                      </div>

                      <div className="shortcut-binding">
                        {renderKeys(effectiveKeys)}
                        {isCustom && (
                          <button
                            className="shortcut-reset-btn"
                            onClick={() => resetCustomBinding(shortcut.id)}
                            title="Reset to default"
                          >
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
          <p>No shortcuts found</p>
        </div>
      )}
    </div>
  )
}
