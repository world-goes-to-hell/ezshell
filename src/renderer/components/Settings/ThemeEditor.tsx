import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import { RiSaveLine, RiRefreshLine, RiEyeLine, RiCloseLine } from 'react-icons/ri'
import { ThemeDefinition, ThemeColors, TerminalColors } from '../../types/theme'
import { modalContentVariants } from '../../lib/animation/variants'
import './ThemeEditor.css'

interface ThemeEditorProps {
  editingTheme?: ThemeDefinition
  onClose: () => void
  onSave: (theme: ThemeDefinition) => void
}

const DEFAULT_THEME: ThemeDefinition = {
  id: '',
  name: '',
  category: 'dark',
  colors: {
    bgPrimary: '#313338',
    bgSecondary: '#2b2d31',
    bgTertiary: '#1e1f22',
    bgHover: '#404249',
    bgActive: '#4752c4',
    bgModifierHover: 'rgba(79, 84, 92, 0.4)',
    bgModifierSelected: 'rgba(79, 84, 92, 0.6)',
    textPrimary: '#f2f3f5',
    textSecondary: '#b5bac1',
    textMuted: '#80848e',
    textLink: '#00a8fc',
    accent: '#5865f2',
    accentHover: '#4752c4',
    accentActive: '#3c45a5',
    success: '#23a55a',
    warning: '#f0b232',
    error: '#f23f43',
    info: '#00a8fc',
    border: '#3f4147',
    borderStrong: '#4e5058',
    shadowColor: 'rgba(0, 0, 0, 0.24)',
    glowColor: 'rgba(88, 101, 242, 0.4)',
  },
  terminal: {
    background: '#1e1f22',
    foreground: '#f2f3f5',
    cursor: '#5865f2',
    cursorAccent: '#1e1f22',
    selectionBackground: 'rgba(88, 101, 242, 0.3)',
    black: '#1e1f22',
    red: '#f23f43',
    green: '#23a55a',
    yellow: '#f0b232',
    blue: '#5865f2',
    magenta: '#eb7cd3',
    cyan: '#00a8fc',
    white: '#f2f3f5',
    brightBlack: '#4e5058',
    brightRed: '#f54e52',
    brightGreen: '#2dc770',
    brightYellow: '#f5bd4f',
    brightBlue: '#7289da',
    brightMagenta: '#f0a4d4',
    brightCyan: '#2dc9ff',
    brightWhite: '#ffffff',
  },
  preview: {
    primary: '#1e1f22',
    secondary: '#313338',
    accent: '#5865f2',
  },
}

export function ThemeEditor({ editingTheme, onClose, onSave }: ThemeEditorProps) {
  const [themeName, setThemeName] = useState('')
  const [themeCategory, setThemeCategory] = useState<'dark' | 'light' | 'special'>('dark')
  const [colors, setColors] = useState<ThemeColors>(DEFAULT_THEME.colors)
  const [terminalColors, setTerminalColors] = useState<TerminalColors>(DEFAULT_THEME.terminal)

  useEffect(() => {
    if (editingTheme) {
      setThemeName(editingTheme.name)
      setThemeCategory(editingTheme.category)
      setColors(editingTheme.colors)
      setTerminalColors(editingTheme.terminal)
    }
  }, [editingTheme])

  const handleColorChange = (key: keyof ThemeColors, value: string) => {
    setColors(prev => ({ ...prev, [key]: value }))
  }

  const handleTerminalColorChange = (key: keyof TerminalColors, value: string) => {
    setTerminalColors(prev => ({ ...prev, [key]: value }))
  }

  const handleReset = () => {
    if (editingTheme) {
      setColors(editingTheme.colors)
      setTerminalColors(editingTheme.terminal)
    } else {
      setColors(DEFAULT_THEME.colors)
      setTerminalColors(DEFAULT_THEME.terminal)
    }
  }

  const handleSave = () => {
    if (!themeName.trim()) {
      alert('테마 이름을 입력해주세요')
      return
    }

    const theme: ThemeDefinition = {
      id: editingTheme?.id || `custom-${Date.now()}`,
      name: themeName,
      category: themeCategory,
      colors,
      terminal: terminalColors,
      preview: {
        primary: colors.bgTertiary,
        secondary: colors.bgPrimary,
        accent: colors.accent,
      },
    }

    onSave(theme)
  }

  const previewStyle = {
    '--preview-bg-primary': colors.bgPrimary,
    '--preview-bg-secondary': colors.bgSecondary,
    '--preview-bg-tertiary': colors.bgTertiary,
    '--preview-text-primary': colors.textPrimary,
    '--preview-text-secondary': colors.textSecondary,
    '--preview-accent': colors.accent,
    '--preview-border': colors.border,
  } as React.CSSProperties

  return (
    <div className="theme-editor-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <motion.div
        className="theme-editor"
        variants={modalContentVariants}
        initial="hidden"
        animate="visible"
        exit="exit"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="theme-editor-header">
          <h2>{editingTheme ? '테마 수정' : '커스텀 테마 만들기'}</h2>
          <button className="theme-editor-close" onClick={onClose}>
            <RiCloseLine size={20} />
          </button>
        </div>

        {/* Content */}
        <div className="theme-editor-content">
          {/* Left: Editor */}
          <div className="theme-editor-left">
            {/* Basic Info */}
            <div className="theme-editor-section">
              <label className="theme-editor-label">테마 이름</label>
              <input
                type="text"
                className="theme-editor-input"
                value={themeName}
                onChange={(e) => setThemeName(e.target.value)}
                placeholder="My Custom Theme"
              />
            </div>

            <div className="theme-editor-section">
              <label className="theme-editor-label">카테고리</label>
              <div className="theme-editor-radio-group">
                <label>
                  <input
                    type="radio"
                    value="dark"
                    checked={themeCategory === 'dark'}
                    onChange={(e) => setThemeCategory(e.target.value as any)}
                  />
                  다크
                </label>
                <label>
                  <input
                    type="radio"
                    value="light"
                    checked={themeCategory === 'light'}
                    onChange={(e) => setThemeCategory(e.target.value as any)}
                  />
                  라이트
                </label>
                <label>
                  <input
                    type="radio"
                    value="special"
                    checked={themeCategory === 'special'}
                    onChange={(e) => setThemeCategory(e.target.value as any)}
                  />
                  특수
                </label>
              </div>
            </div>

            {/* UI Colors */}
            <div className="theme-editor-section">
              <h3 className="theme-editor-section-title">UI 색상</h3>
              <div className="theme-editor-color-grid">
                <ColorPicker
                  label="배경 (Primary)"
                  value={colors.bgPrimary}
                  onChange={(v) => handleColorChange('bgPrimary', v)}
                />
                <ColorPicker
                  label="배경 (Secondary)"
                  value={colors.bgSecondary}
                  onChange={(v) => handleColorChange('bgSecondary', v)}
                />
                <ColorPicker
                  label="배경 (Tertiary)"
                  value={colors.bgTertiary}
                  onChange={(v) => handleColorChange('bgTertiary', v)}
                />
                <ColorPicker
                  label="텍스트 (Primary)"
                  value={colors.textPrimary}
                  onChange={(v) => handleColorChange('textPrimary', v)}
                />
                <ColorPicker
                  label="텍스트 (Secondary)"
                  value={colors.textSecondary}
                  onChange={(v) => handleColorChange('textSecondary', v)}
                />
                <ColorPicker
                  label="텍스트 (Muted)"
                  value={colors.textMuted}
                  onChange={(v) => handleColorChange('textMuted', v)}
                />
                <ColorPicker
                  label="액센트"
                  value={colors.accent}
                  onChange={(v) => handleColorChange('accent', v)}
                />
                <ColorPicker
                  label="테두리"
                  value={colors.border}
                  onChange={(v) => handleColorChange('border', v)}
                />
              </div>
            </div>

            {/* Terminal Colors */}
            <div className="theme-editor-section">
              <h3 className="theme-editor-section-title">터미널 색상</h3>
              <div className="theme-editor-color-grid">
                <ColorPicker
                  label="배경"
                  value={terminalColors.background}
                  onChange={(v) => handleTerminalColorChange('background', v)}
                />
                <ColorPicker
                  label="전경"
                  value={terminalColors.foreground}
                  onChange={(v) => handleTerminalColorChange('foreground', v)}
                />
                <ColorPicker
                  label="커서"
                  value={terminalColors.cursor}
                  onChange={(v) => handleTerminalColorChange('cursor', v)}
                />
                <ColorPicker
                  label="Red"
                  value={terminalColors.red}
                  onChange={(v) => handleTerminalColorChange('red', v)}
                />
                <ColorPicker
                  label="Green"
                  value={terminalColors.green}
                  onChange={(v) => handleTerminalColorChange('green', v)}
                />
                <ColorPicker
                  label="Yellow"
                  value={terminalColors.yellow}
                  onChange={(v) => handleTerminalColorChange('yellow', v)}
                />
                <ColorPicker
                  label="Blue"
                  value={terminalColors.blue}
                  onChange={(v) => handleTerminalColorChange('blue', v)}
                />
                <ColorPicker
                  label="Magenta"
                  value={terminalColors.magenta}
                  onChange={(v) => handleTerminalColorChange('magenta', v)}
                />
                <ColorPicker
                  label="Cyan"
                  value={terminalColors.cyan}
                  onChange={(v) => handleTerminalColorChange('cyan', v)}
                />
              </div>
            </div>
          </div>

          {/* Right: Preview */}
          <div className="theme-editor-right">
            <div className="theme-editor-preview" style={previewStyle}>
              <div className="theme-preview-header">
                <RiEyeLine size={16} />
                <span>미리보기</span>
              </div>
              <div className="theme-preview-window">
                <div className="theme-preview-titlebar">
                  <div className="theme-preview-dots">
                    <span></span>
                    <span></span>
                    <span></span>
                  </div>
                  <span className="theme-preview-title">SSH Terminal</span>
                </div>
                <div className="theme-preview-terminal">
                  <div className="theme-preview-terminal-line">
                    <span style={{ color: terminalColors.green }}>user@host</span>
                    <span style={{ color: terminalColors.foreground }}>:</span>
                    <span style={{ color: terminalColors.blue }}>~</span>
                    <span style={{ color: terminalColors.foreground }}>$</span>
                  </div>
                  <div className="theme-preview-terminal-line">
                    <span style={{ color: terminalColors.foreground }}>ls -la</span>
                  </div>
                  <div className="theme-preview-terminal-line">
                    <span style={{ color: terminalColors.cyan }}>drwxr-xr-x</span>
                    <span style={{ color: terminalColors.foreground }}> 5 user user</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="theme-editor-footer">
          <button className="theme-editor-btn theme-editor-btn-secondary" onClick={handleReset}>
            <RiRefreshLine size={16} />
            초기화
          </button>
          <button className="theme-editor-btn theme-editor-btn-primary" onClick={handleSave}>
            <RiSaveLine size={16} />
            저장
          </button>
        </div>
      </motion.div>
    </div>
  )
}

interface ColorPickerProps {
  label: string
  value: string
  onChange: (value: string) => void
}

function ColorPicker({ label, value, onChange }: ColorPickerProps) {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onChange(e.target.value)
  }

  // Extract hex color from rgba if needed
  const hexValue = value.startsWith('rgba') || value.startsWith('rgb')
    ? '#000000'
    : value

  return (
    <div className="color-picker">
      <label className="color-picker-label">{label}</label>
      <div className="color-picker-input-wrapper">
        <input
          type="color"
          className="color-picker-swatch"
          value={hexValue}
          onChange={handleChange}
        />
        <input
          type="text"
          className="color-picker-text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
    </div>
  )
}
