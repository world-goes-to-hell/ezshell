import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { RiCloseLine, RiFileTextLine } from 'react-icons/ri'
import type { ConfigDefinition } from '../../types'

export type DefinitionState =
  | { status: 'loading' }
  | { status: 'ready'; results: ConfigDefinition[]; truncated: boolean }
  | { status: 'error'; message: string }

interface DefinitionListProps {
  name: string
  fallback: string | null
  at: { x: number; y: number }
  state: DefinitionState
  isLocal: boolean
  onPick: (key: string) => void
  onClose: () => void
}

/**
 * Where a placeholder's name is set: the default written in the placeholder, then each file and line
 * that sets it. Picking one opens that file at the line. Esc or a click outside closes the list.
 */
export function DefinitionList({ name, fallback, at, state, isLocal, onPick, onClose }: DefinitionListProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState({ left: at.x, top: at.y + 14 })

  // Kept inside the window (open upward / leftward near the edges)
  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect()
    if (!box) return
    const left = Math.max(8, Math.min(at.x, window.innerWidth - box.width - 8))
    const below = at.y + 14
    const top = below + box.height > window.innerHeight - 8 ? Math.max(8, at.y - box.height - 8) : below
    setPlace({ left, top })
  }, [at.x, at.y, state])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); onClose() } }
    const onDown = (event: MouseEvent) => { if (!ref.current?.contains(event.target as Node)) onClose() }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('mousedown', onDown, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('mousedown', onDown, true)
    }
  }, [onClose])

  const scope = isLocal ? '작업 폴더' : '이 파일의 폴더와 위쪽 폴더 3단계'
  return (
    <div className="definition-list" ref={ref} style={place} role="dialog" aria-label={`${name} 을 정하는 곳`}>
      <div className="definition-list-head">
        <span className="definition-list-name">{name}</span>
        <button type="button" className="definition-list-close" onClick={onClose} aria-label="닫기"><RiCloseLine size={14} /></button>
      </div>
      {fallback !== null && (
        <div className="definition-list-fallback" title="정하는 곳이 없을 때 쓰는 값">
          <span>기본값</span><code>{fallback === '' ? '(빈 값)' : fallback}</code>
        </div>
      )}
      {state.status === 'loading' && <p className="definition-list-note">{scope}에서 찾는 중…</p>}
      {state.status === 'error' && <p className="definition-list-note is-error">{state.message}</p>}
      {state.status === 'ready' && state.results.length === 0 && (
        <p className="definition-list-note">{scope}에서 이 이름을 정하는 곳을 찾지 못했습니다.{fallback !== null ? ' 기본값이 쓰입니다.' : ''}</p>
      )}
      {state.status === 'ready' && state.results.length > 0 && (
        <ul className="definition-list-items">
          {state.results.map(result => (
            <li key={result.key}>
              <button type="button" className="definition-list-item" onClick={() => onPick(result.key)} title={`${result.path}:${result.line}`}>
                <span className="definition-list-file"><RiFileTextLine size={13} aria-hidden="true" />{result.path}<span className="definition-list-line">:{result.line}</span></span>
                <code className="definition-list-text">{result.text}</code>
              </button>
            </li>
          ))}
        </ul>
      )}
      {state.status === 'ready' && state.truncated && <p className="definition-list-note">찾는 범위가 커서 앞부분만 찾았습니다.</p>}
    </div>
  )
}
