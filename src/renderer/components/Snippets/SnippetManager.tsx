import { useState, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { RiSearchLine, RiAddLine, RiCloseLine, RiCommandLine, RiEditLine, RiDeleteBinLine, RiPlayLine } from 'react-icons/ri'
import { useSnippetStore } from '../../stores/snippetStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useTerminalStore } from '../../stores/terminalStore'
import { SnippetModal } from './SnippetModal'
import { useReducedMotion } from '../../hooks/useReducedMotion'
import { modalOverlayVariants } from '../../lib/animation/variants'
import { confirmDialog } from '../../stores/confirmStore'
import { SelectMenu } from '../ui/SelectMenu'
import './SnippetManager.css'

interface SnippetManagerProps {
  onClose: () => void
}

export function SnippetManager({ onClose }: SnippetManagerProps) {
  const [searchQuery, setSearchQuery] = useState('')
  const [categoryFilter, setCategoryFilter] = useState<string>('all')
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [editingSnippetId, setEditingSnippetId] = useState<string | null>(null)

  const { snippets, deleteSnippet, expandVariables } = useSnippetStore()
  const { activeSessionId } = useSessionStore()
  const { getTerminal } = useTerminalStore()
  const reducedMotion = useReducedMotion()

  // Get unique categories
  const categories = useMemo(() => {
    const cats = new Set(snippets.map(s => s.category).filter((category): category is string => Boolean(category)))
    return ['all', ...Array.from(cats)]
  }, [snippets])
  // The chosen category disappears when its last snippet is deleted or moved: fall back to all
  const activeCategory = categories.includes(categoryFilter) ? categoryFilter : 'all'

  // Filter snippets
  const filteredSnippets = useMemo(() => {
    let filtered = snippets

    // Filter by category
    if (activeCategory !== 'all') {
      filtered = filtered.filter(s => s.category === activeCategory)
    }

    // Filter by search query
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase()
      filtered = filtered.filter(s =>
        s.name.toLowerCase().includes(query) ||
        s.description?.toLowerCase().includes(query) ||
        s.command.toLowerCase().includes(query) ||
        s.category?.toLowerCase().includes(query)
      )
    }

    // Sort by creation date (newest first)
    return filtered.sort((a, b) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    )
  }, [snippets, activeCategory, searchQuery])

  const handleInsert = (command: string) => {
    if (!activeSessionId) {
      return
    }

    const terminal = getTerminal(activeSessionId)
    if (!terminal) {
      return
    }

    // Expand variables
    const context = {
      user: terminal.username,
      host: terminal.host,
      path: terminal.currentPath || '~'
    }

    const expandedCommand = expandVariables(command, context)

    // Send to terminal
    window.electronAPI.sshSend(activeSessionId, expandedCommand + '\n')
    onClose()
  }

  const handleEdit = (snippetId: string) => {
    setEditingSnippetId(snippetId)
    setIsModalOpen(true)
  }

  const handleDelete = async (snippetId: string) => {
    const name = snippets.find(snippet => snippet.id === snippetId)?.name ?? '이 스니펫'
    const confirmed = await confirmDialog({
      title: '스니펫 삭제',
      message: `"${name}" 스니펫을 삭제합니다.`,
      confirmLabel: '삭제',
      danger: true
    })
    if (confirmed) deleteSnippet(snippetId)
  }

  const handleAddNew = () => {
    setEditingSnippetId(null)
    setIsModalOpen(true)
  }

  const handleModalClose = () => {
    setIsModalOpen(false)
    setEditingSnippetId(null)
  }

  return (
    <AnimatePresence>
      <motion.div
        className="snippet-manager-overlay"
        variants={modalOverlayVariants}
        initial="hidden"
        animate="visible"
        exit="exit"
        onClick={onClose}
      >
        <motion.div
          className="snippet-manager"
          initial={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.95 }}
          animate={reducedMotion ? { opacity: 1 } : { opacity: 1, scale: 1 }}
          exit={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.95 }}
          transition={{ duration: 0.15 }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="snippet-manager-header">
            <h2>Snippet Manager</h2>
            <div className="snippet-manager-header-actions">
              <button className="btn btn-primary" onClick={handleAddNew}>
                <RiAddLine size={18} />
                Add Snippet
              </button>
              <button className="btn-icon" onClick={onClose}>
                <RiCloseLine size={20} />
              </button>
            </div>
          </div>

          {/* Toolbar */}
          <div className="snippet-manager-toolbar">
            <div className="snippet-search">
              <RiSearchLine size={18} style={{ color: 'var(--text-muted)' }} />
              <input
                type="text"
                placeholder="Search snippets..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>
            <SelectMenu
              className="snippet-category-filter"
              ariaLabel="분류"
              value={activeCategory}
              options={categories.map(cat => ({ value: cat, label: cat === 'all' ? '전체 분류' : cat }))}
              onChange={setCategoryFilter}
            />
          </div>

          {/* Content */}
          <div className="snippet-manager-content">
            {filteredSnippets.length === 0 ? (
              <div className="snippet-list-empty">
                <div className="snippet-list-empty-icon">
                  <RiCommandLine />
                </div>
                <p>No snippets found</p>
                {searchQuery || activeCategory !== 'all' ? (
                  <p style={{ fontSize: '13px', marginTop: '8px' }}>
                    Try adjusting your filters
                  </p>
                ) : (
                  <button className="btn btn-primary" onClick={handleAddNew} style={{ marginTop: '16px' }}>
                    <RiAddLine size={18} />
                    Create your first snippet
                  </button>
                )}
              </div>
            ) : (
              <div className="snippet-list">
                {filteredSnippets.map(snippet => (
                  <motion.div
                    key={snippet.id}
                    className="snippet-item"
                    layout
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -20 }}
                  >
                    <div className="snippet-item-icon">
                      <RiCommandLine size={20} />
                    </div>
                    <div className="snippet-item-content">
                      <div className="snippet-item-header">
                        <span className="snippet-item-name">{snippet.name}</span>
                        {snippet.category && (
                          <span className="snippet-item-category">{snippet.category}</span>
                        )}
                      </div>
                      {snippet.description && (
                        <div className="snippet-item-description">{snippet.description}</div>
                      )}
                      <div className="snippet-item-command">{snippet.command}</div>
                    </div>
                    <div className="snippet-item-actions">
                      <button
                        className="btn-icon"
                        title="Insert into terminal"
                        onClick={() => handleInsert(snippet.command)}
                        disabled={!activeSessionId}
                      >
                        <RiPlayLine size={18} />
                      </button>
                      <button
                        className="btn-icon"
                        title="Edit snippet"
                        onClick={() => handleEdit(snippet.id)}
                      >
                        <RiEditLine size={18} />
                      </button>
                      <button
                        className="btn-icon btn-icon-danger"
                        title="Delete snippet"
                        onClick={() => handleDelete(snippet.id)}
                      >
                        <RiDeleteBinLine size={18} />
                      </button>
                    </div>
                  </motion.div>
                ))}
              </div>
            )}
          </div>
        </motion.div>
      </motion.div>

      {/* Snippet Modal */}
      {isModalOpen && (
        <SnippetModal
          snippetId={editingSnippetId}
          onClose={handleModalClose}
        />
      )}
    </AnimatePresence>
  )
}
