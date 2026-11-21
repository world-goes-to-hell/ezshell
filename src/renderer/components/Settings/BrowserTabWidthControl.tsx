import { useUIStore } from '../../stores/uiStore'
import { BROWSER_TAB_WIDTH_MAX, BROWSER_TAB_WIDTH_MIN, BROWSER_TAB_WIDTH_STEP } from '../../lib/browserTabWidth'

export function BrowserTabWidthControl() {
  const width = useUIStore(state => state.browserTabMaxWidth)
  const setWidth = useUIStore(state => state.setBrowserTabMaxWidth)

  return (
    <section className="settings-section">
      <div className="font-size-header">
        <label htmlFor="browser-tab-width">브라우저 탭 최대 너비</label>
        <output className="font-size-value" htmlFor="browser-tab-width">{width}px</output>
      </div>
      <input id="browser-tab-width" className="font-size-slider" type="range" value={width} aria-valuetext={`${width}px`}
        min={BROWSER_TAB_WIDTH_MIN} max={BROWSER_TAB_WIDTH_MAX} step={BROWSER_TAB_WIDTH_STEP}
        onChange={event => setWidth(event.currentTarget.valueAsNumber)} />
    </section>
  )
}
