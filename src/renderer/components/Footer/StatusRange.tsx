import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import './StatusRange.css'

interface StatusRangeProps {
  label: string
  icon: ReactNode
  open: boolean
  onOpenChange: (open: boolean) => void
  value: number
  min: number
  max: number
  step?: number
  toPercent?: (value: number) => number
  onValueChange: (value: number) => void
  onReset: () => void
  commitOnRelease?: boolean
}

const asPercent = (value: number) => value

export function StatusRange({ label, icon, open, onOpenChange, value, min, max, step = 1,
  toPercent = asPercent, onValueChange, onReset, commitOnRelease = false }: StatusRangeProps) {
  const panelId = useId()
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const range = useRef<HTMLInputElement>(null)
  const [preview, setPreview] = useState<number | null>(null)
  const percent = toPercent(value)
  const previewPercent = toPercent(preview ?? value)

  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) {
        setPreview(null)
        onOpenChange(false)
      }
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setPreview(null)
      onOpenChange(false)
      if (root.current?.contains(document.activeElement)) trigger.current?.focus()
    }
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('keydown', escape)
    }
  }, [open, onOpenChange])

  useEffect(() => {
    const input = range.current
    if (!open || !commitOnRelease || !input) return
    // The native change event commits a drag on release. Until then, keep the slider in place
    // when its value controls the scale of the surrounding UI.
    const commit = () => {
      onValueChange(input.valueAsNumber)
      setPreview(null)
    }
    input.addEventListener('change', commit)
    return () => input.removeEventListener('change', commit)
  }, [open, commitOnRelease, onValueChange])

  return (
    <div className="status-range" ref={root}>
      <button type="button" ref={trigger} className={`status-range-trigger${percent !== 100 ? ' changed' : ''}`}
        aria-expanded={open} aria-controls={open ? panelId : undefined} aria-label={`${label} ${percent}%`} title={`${label} ${percent}%`}
        onClick={() => { setPreview(null); onOpenChange(!open) }}>
        {icon}<span>{percent}%</span>
      </button>
      {open && (
        <div className="status-range-panel" id={panelId} role="dialog" aria-label={label}>
          <div className="status-range-head">
            <span>{label}</span>
            <span className="status-range-value">{previewPercent}%</span>
          </div>
          <input ref={range} type="range" min={min} max={max} step={step} value={preview ?? value}
            aria-label={label} aria-valuetext={`${previewPercent}%`} autoFocus
            onInput={event => {
              const next = event.currentTarget.valueAsNumber
              if (commitOnRelease) setPreview(next)
              else onValueChange(next)
            }} />
          <button type="button" className="status-range-reset" onClick={onReset} disabled={percent === 100}>
            100%로 되돌리기
          </button>
        </div>
      )}
    </div>
  )
}
