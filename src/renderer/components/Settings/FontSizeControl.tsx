import { useTerminalStore, TERMINAL_FONTS } from '../../stores/terminalStore'
import { SelectMenu } from '../ui/SelectMenu'
import { RiAddLine, RiSubtractLine, RiRestartLine } from 'react-icons/ri'

export function FontSizeControl() {
  const fontSize = useTerminalStore(state => state.fontSize)
  const fontFamily = useTerminalStore(state => state.fontFamily)
  const setFontSize = useTerminalStore(state => state.setFontSize)
  const setFontFamily = useTerminalStore(state => state.setFontFamily)
  const increaseFontSize = useTerminalStore(state => state.increaseFontSize)
  const decreaseFontSize = useTerminalStore(state => state.decreaseFontSize)
  const resetFontSize = useTerminalStore(state => state.resetFontSize)

  const handleSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFontSize(parseInt(e.target.value, 10))
  }


  return (
    <div className="font-size-control">
      <div className="font-setting-group">
        <div className="font-size-header">
          <label htmlFor="font-family-select">글꼴</label>
        </div>
        {/* Each option is set in its own font, so the list doubles as a preview */}
        <SelectMenu
          id="font-family-select"
          ariaLabel="글꼴"
          value={fontFamily}
          options={TERMINAL_FONTS.map(font => ({ value: font.value, label: font.name, style: { fontFamily: font.value } }))}
          onChange={setFontFamily}
        />
      </div>

      <div className="font-setting-group">
        <div className="font-size-header">
          <label htmlFor="font-size-slider">글꼴 크기</label>
          <span className="font-size-value">{fontSize}px</span>
        </div>

        <div className="font-size-slider-container">
          <button
            className="font-size-btn"
            onClick={decreaseFontSize}
            title="글꼴 크기 축소 (Ctrl+-)"
            aria-label="Decrease font size"
          >
            <RiSubtractLine size={18} />
          </button>

          <input
            id="font-size-slider"
            type="range"
            min="10"
            max="24"
            step="1"
            value={fontSize}
            onChange={handleSliderChange}
            className="font-size-slider"
            aria-label="Font size slider"
          />

          <button
            className="font-size-btn"
            onClick={increaseFontSize}
            title="글꼴 크기 확대 (Ctrl++)"
            aria-label="Increase font size"
          >
            <RiAddLine size={18} />
          </button>

          <button
            className="font-size-btn"
            onClick={resetFontSize}
            title="기본 크기로 재설정 (Ctrl+0)"
            aria-label="Reset font size"
          >
            <RiRestartLine size={18} />
          </button>
        </div>

        <div className="font-size-shortcuts">
          <span className="shortcut-hint">
            <kbd>Ctrl</kbd>+<kbd>+</kbd> 확대 / <kbd>Ctrl</kbd>+<kbd>-</kbd> 축소 / <kbd>Ctrl</kbd>+<kbd>0</kbd> 재설정
          </span>
        </div>
      </div>
    </div>
  )
}
