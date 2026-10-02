import { useState } from 'react'
import { RiCheckFill, RiAddLine, RiEditLine, RiDeleteBinLine, RiUploadLine, RiDownloadLine } from 'react-icons/ri'
import { AnimatePresence } from 'framer-motion'
import { useThemeStore } from '../../stores/themeStore'
import { ThemeCategory, ThemeDefinition } from '../../types/theme'
import { ThemeEditor } from './ThemeEditor'
import { confirmDialog } from '../../stores/confirmStore'
import { toast } from '../../stores/toastStore'

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

  const handleDeleteTheme = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    const name = allThemes.find(theme => theme.id === id)?.name ?? '이 테마'
    const confirmed = await confirmDialog({
      title: '테마 삭제',
      message: `"${name}" 테마를 삭제합니다.`,
      confirmLabel: '삭제',
      danger: true
    })
    if (confirmed) deleteCustomTheme(id)
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
            toast.success('테마 가져오기', '테마를 가져왔습니다')
          } else {
            toast.error('테마 가져오기 실패', '테마 파일이 올바르지 않습니다')
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
      {/* Actions and filters stay pinned while the settings tab scrolls the grid */}
      <div className="theme-toolbar">
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
      </div>

      {/* Theme Grid */}
      <div className="theme-grid">
        {filteredThemes.map(theme => {
          const isSelected = currentThemeId === theme.id
          return (
            // The card is a container: selecting is one button, and the custom-theme actions are buttons next to it
            // (a button may not contain buttons)
            <div key={theme.id} className={`theme-card ${isSelected ? 'selected' : ''}`}>
              <button
                type="button"
                className="theme-card-main"
                aria-pressed={isSelected}
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
                  {isSelected && (
                    <div className="theme-selected-badge">
                      <RiCheckFill size={16} />
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

              {/* Custom theme actions: over the preview, shown on hover or keyboard focus */}
              {isCustomTheme(theme.id) && (
                <div className="theme-card-actions">
                  <button
                    type="button"
                    className="theme-card-action"
                    onClick={(e) => handleEditTheme(theme, e)}
                    title="수정"
                    aria-label={`${theme.name} 수정`}
                  >
                    <RiEditLine size={16} />
                  </button>
                  <button
                    type="button"
                    className="theme-card-action"
                    onClick={(e) => handleExportTheme(theme.id, e)}
                    title="내보내기"
                    aria-label={`${theme.name} 내보내기`}
                  >
                    <RiDownloadLine size={16} />
                  </button>
                  <button
                    type="button"
                    className="theme-card-action theme-card-action-danger"
                    onClick={(e) => handleDeleteTheme(theme.id, e)}
                    title="삭제"
                    aria-label={`${theme.name} 삭제`}
                  >
                    <RiDeleteBinLine size={16} />
                  </button>
                </div>
              )}
            </div>
          )
        })}
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
