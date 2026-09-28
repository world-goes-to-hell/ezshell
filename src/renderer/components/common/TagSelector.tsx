import { useState } from 'react'
import { Tag } from '../../stores/sessionStore'
import { TagBadge } from './TagBadge'
import { RiAddLine, RiCheckLine } from 'react-icons/ri'
import './TagSelector.css'

interface TagSelectorProps {
  availableTags: Tag[]
  selectedTagIds: string[]
  onToggleTag: (tagId: string) => void
  onCreateTag: (tag: Tag) => void
}

const TAG_COLORS = [
  '#ef4444', // red
  '#f97316', // orange
  '#f59e0b', // amber
  '#22c55e', // green
  '#3b82f6', // blue
  '#a855f7', // purple
  '#ec4899', // pink
  '#14b8a6', // teal
]

export function TagSelector({ availableTags, selectedTagIds, onToggleTag, onCreateTag }: TagSelectorProps) {
  const [isCreating, setIsCreating] = useState(false)
  const [newTagName, setNewTagName] = useState('')
  const [selectedColor, setSelectedColor] = useState(TAG_COLORS[0])

  const handleCreateTag = () => {
    if (!newTagName.trim()) return

    const newTag: Tag = {
      id: crypto.randomUUID(),
      name: newTagName.trim(),
      color: selectedColor
    }

    onCreateTag(newTag)
    onToggleTag(newTag.id)
    setNewTagName('')
    setIsCreating(false)
    setSelectedColor(TAG_COLORS[0])
  }

  const handleCancel = () => {
    setIsCreating(false)
    setNewTagName('')
    setSelectedColor(TAG_COLORS[0])
  }

  return (
    <div className="tag-selector">
      <div className="tag-selector-list">
        {availableTags.map(tag => {
          const isSelected = selectedTagIds.includes(tag.id)
          return (
            <label
              key={tag.id}
              className={`tag-selector-item ${isSelected ? 'selected' : ''}`}
            >
              <input
                type="checkbox"
                checked={isSelected}
                onChange={() => onToggleTag(tag.id)}
              />
              <TagBadge name={tag.name} color={tag.color} size="sm" />
              {isSelected && <RiCheckLine className="check-icon" size={16} />}
            </label>
          )
        })}
      </div>

      {isCreating ? (
        <div className="tag-creator">
          <input
            type="text"
            className="tag-creator-input"
            placeholder="Tag name"
            value={newTagName}
            onChange={(e) => setNewTagName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleCreateTag()
              if (e.key === 'Escape') handleCancel()
            }}
            autoFocus
          />
          <div className="tag-creator-colors">
            {TAG_COLORS.map(color => (
              <button
                key={color}
                type="button"
                className={`color-option ${selectedColor === color ? 'selected' : ''}`}
                style={{ backgroundColor: color }}
                onClick={() => setSelectedColor(color)}
                aria-label={`Select color ${color}`}
              />
            ))}
          </div>
          <div className="tag-creator-actions">
            <button type="button" className="btn-cancel" onClick={handleCancel}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-create"
              onClick={handleCreateTag}
              disabled={!newTagName.trim()}
            >
              Create
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="tag-selector-add"
          onClick={() => setIsCreating(true)}
        >
          <RiAddLine size={16} />
          <span>Create new tag</span>
        </button>
      )}
    </div>
  )
}
