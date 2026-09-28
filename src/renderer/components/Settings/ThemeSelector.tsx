import { useState } from 'react'
import { RiCheckFill, RiAddLine, RiEditLine, RiDeleteBinLine, RiUploadLine, RiDownloadLine } from 'react-icons/ri'
import { AnimatePresence } from 'framer-motion'
import { useThemeStore } from '../../stores/themeStore'
import { ThemeCategory, ThemeDefinition } from '../../types/theme'
import { ThemeEditor } from './ThemeEditor'

type FilterTab = 'all' | ThemeCategory | 'custom'

export function ThemeSelector() {
  const [filter, setFilter] = useState<FilterTab>('all')
  const [showEditor, setShowEditor] = useState(false)
  const [editingTheme, setEditingTheme] = useState<ThemeDefinition | undefined>()

  const {
    currentThemeId,
    setTheme,
    getAllThemes,
    customThemes,
    saveCustomTheme,
    deleteCustomTheme,
    exportTheme,
    importTheme
  } = useThemeStore()

  const allThemes = getAllThemes()

  const filteredThemes = filter === 'all'
    ? allThemes
    : filter === 'custom'
    ? customThemes
    : allThemes.filter(theme => theme.category === filter)

  const tabs: { id: FilterTab; label: string }[] = [
    { id: 'all', label: '전체' },
    { id: 'dark', label: '다크' },
    { id: 'light', label: '라이트' },
    { id: 'special', label: '특수' },
    { id: 'custom', label: '커스텀' },
  ]

  const handleCreateTheme = () => {
    setEditingTheme(undefined)
    setShowEditor(true)
  }

  const handleEditTheme = (theme: ThemeDefinition, e: React.MouseEvent) => {
    e.stopPropagation()
    setEditingTheme(theme)
    setShowEditor(true)
  }

  const handleDeleteTheme = (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    if (confirm('이 테마를 삭제하시겠습니까?')) {
      deleteCustomTheme(id)
    }
  }

  const handleSaveTheme = (theme: ThemeDefinition) => {
    saveCustomTheme(theme)
    setShowEditor(false)
    setEditingTheme(undefined)
    setTheme(theme.id)
  }

  const handleExportTheme = (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    const json = exportTheme(id)
    if (json) {
      const blob = new Blob([json], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `theme-${id}.json`
      a.click()
      URL.revokeObjectURL(url)
    }
  }

  const handleImportTheme = () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json'
    input.onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0]
      if (file) {
        const reader = new FileReader()
        reader.onload = (event) => {
          const json = event.target?.result as string
          if (importTheme(json)) {
            alert('테마를 가져왔습니다')
          } else {
            alert('테마 파일이 올바르지 않습니다')
          }
        }
        reader.readAsText(file)
      }
    }
    input.click()
  }

  const isCustomTheme = (themeId: string) => {
    return customThemes.some(t => t.id === themeId)
  }

  return (
    <div className="theme-selector">
      {/* Action Buttons */}
      <div className="theme-actions">
        <button className="theme-action-btn theme-action-btn-primary" onClick={handleCreateTheme}>
          <RiAddLine size={18} />
          커스텀 테마 만들기
        </button>
        <div className="theme-actions-right">
          <button className="theme-action-btn" onClick={handleImportTheme}>
            <RiUploadLine size={18} />
            가져오기
          </button>
        </div>
      </div>

      {/* Filter Tabs */}
      <div className="theme-filter-tabs">
        {tabs.map(tab => (
          <button
            key={tab.id}
            className={`theme-filter-tab ${filter === tab.id ? 'active' : ''}`}
            onClick={() => setFilter(tab.id)}
          >
            {tab.label}
            {tab.id === 'custom' && customThemes.length > 0 && (
              <span className="theme-tab-badge">{customThemes.length}</span>
            )}
          </button>
        ))}
      </div>

      {/* Theme Grid */}
      <div className="theme-grid">
        {filteredThemes.map(theme => (
          <button
            key={theme.id}
            className={`theme-card ${currentThemeId === theme.id ? 'selected' : ''}`}
            onClick={() => setTheme(theme.id)}
          >
            {/* Preview Thumbnail */}
            <div className="theme-preview">
              <div
                className="theme-preview-bg"
                style={{ background: theme.preview.primary }}
              >
                <div
                  className="theme-preview-secondary"
                  style={{ background: theme.preview.secondary }}
                />
                <div
                  className="theme-preview-accent"
                  style={{ background: theme.preview.accent }}
                />
              </div>
              {/* Selection indicator */}
              {currentThemeId === theme.id && (
                <div className="theme-selected-badge">
                  <RiCheckFill size={16} />
                </div>
              )}
              {/* Custom theme actions */}
              {isCustomTheme(theme.id) && (
                <div className="theme-card-actions">
                  <button
                    className="theme-card-action"
                    onClick={(e) => handleEditTheme(theme, e)}
                    title="수정"
                  >
                    <RiEditLine size={16} />
                  </button>
                  <button
                    className="theme-card-action"
                    onClick={(e) => handleExportTheme(theme.id, e)}
                    title="내보내기"
                  >
                    <RiDownloadLine size={16} />
                  </button>
                  <button
                    className="theme-card-action theme-card-action-danger"
                    onClick={(e) => handleDeleteTheme(theme.id, e)}
                    title="삭제"
                  >
                    <RiDeleteBinLine size={16} />
                  </button>
                </div>
              )}
            </div>

            {/* Theme Info */}
            <div className="theme-info">
              <span className="theme-name">{theme.name}</span>
              <span className="theme-category">
                {theme.category === 'dark' && '다크'}
                {theme.category === 'light' && '라이트'}
                {theme.category === 'special' && '특수'}
              </span>
            </div>
          </button>
        ))}
      </div>

      {/* Theme Editor Modal */}
      <AnimatePresence>
        {showEditor && (
          <ThemeEditor
            editingTheme={editingTheme}
            onClose={() => {
              setShowEditor(false)
              setEditingTheme(undefined)
            }}
            onSave={handleSaveTheme}
          />
        )}
      </AnimatePresence>
    </div>
  )
}
