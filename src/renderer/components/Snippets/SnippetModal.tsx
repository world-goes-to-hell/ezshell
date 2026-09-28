import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import { RiCloseLine, RiSaveLine } from 'react-icons/ri'
import { useSnippetStore } from '../../stores/snippetStore'
import { useReducedMotion } from '../../hooks/useReducedMotion'
import { modalOverlayVariants } from '../../lib/animation/variants'
import './SnippetModal.css'

interface SnippetModalProps {
  snippetId: string | null
  onClose: () => void
}

export function SnippetModal({ snippetId, onClose }: SnippetModalProps) {
  const { snippets, addSnippet, updateSnippet } = useSnippetStore()
  const reducedMotion = useReducedMotion()

  const editingSnippet = snippetId ? snippets.find(s => s.id === snippetId) : null

  const [name, setName] = useState(editingSnippet?.name || '')
  const [description, setDescription] = useState(editingSnippet?.description || '')
  const [command, setCommand] = useState(editingSnippet?.command || '')
  const [category, setCategory] = useState(editingSnippet?.category || 'General')

  // Get existing categories for dropdown
  const existingCategories = Array.from(new Set(snippets.map(s => s.category).filter(Boolean)))

  useEffect(() => {
    if (editingSnippet) {
      setName(editingSnippet.name)
      setDescription(editingSnippet.description || '')
      setCommand(editingSnippet.command)
      setCategory(editingSnippet.category || 'General')
    }
  }, [editingSnippet])

  const handleSave = () => {
    if (!name.trim() || !command.trim()) {
      return
    }

    const snippetData = {
      name: name.trim(),
      description: description.trim() || undefined,
      command: command.trim(),
      category: category.trim() || undefined
    }

    if (snippetId) {
      updateSnippet(snippetId, snippetData)
    } else {
      addSnippet(snippetData)
    }

    onClose()
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose()
    } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      handleSave()
    }
  }

  return (
    <motion.div
      className="snippet-modal-overlay"
      variants={modalOverlayVariants}
      initial="hidden"
      animate="visible"
      exit="exit"
      onClick={onClose}
    >
      <motion.div
        className="snippet-modal"
        initial={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.95 }}
        animate={reducedMotion ? { opacity: 1 } : { opacity: 1, scale: 1 }}
        exit={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.95 }}
        transition={{ duration: 0.15 }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* Header */}
        <div className="snippet-modal-header">
          <h3>{snippetId ? 'Edit Snippet' : 'Add New Snippet'}</h3>
          <button className="btn-icon" onClick={onClose}>
            <RiCloseLine size={20} />
          </button>
        </div>

        {/* Content */}
        <div className="snippet-modal-content">
          <div className="snippet-modal-field">
            <label htmlFor="snippet-name">Name *</label>
            <input
              id="snippet-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., List files"
              autoFocus
            />
          </div>

          <div className="snippet-modal-field">
            <label htmlFor="snippet-category">Category</label>
            <input
              id="snippet-category"
              type="text"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder="e.g., File System"
              list="category-suggestions"
            />
            <datalist id="category-suggestions">
              {existingCategories.map(cat => (
                <option key={cat} value={cat} />
              ))}
            </datalist>
          </div>

          <div className="snippet-modal-field">
            <label htmlFor="snippet-description">Description</label>
            <input
              id="snippet-description"
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Brief description of what this command does"
            />
          </div>

          <div className="snippet-modal-field">
            <label htmlFor="snippet-command">Command *</label>
            <textarea
              id="snippet-command"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="Enter your command here..."
              rows={4}
            />
            <div className="snippet-modal-hint">
              You can use variables: ${'{'}date{'}'}, ${'{'}time{'}'}, ${'{'}user{'}'}, ${'{'}host{'}'}, ${'{'}path{'}'}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="snippet-modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={handleSave}
            disabled={!name.trim() || !command.trim()}
          >
            <RiSaveLine size={18} />
            {snippetId ? 'Update' : 'Create'}
          </button>
        </div>
      </motion.div>
    </motion.div>
  )
}
