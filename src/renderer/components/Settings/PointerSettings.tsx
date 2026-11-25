import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { CURSOR_SETS, CURSOR_SIZES, type CursorSet, type CursorSize } from '../../lib/pointerCursors'
import { cursorImageUrl, ghostCursor } from '../../lib/pointerAppearance'
import {
  DEFAULT_POINTER_PREFS, getPointerPrefs, setPointerPrefs, subscribePointerPrefs,
  type ClickEffect, type EffectLevel, type MoveEffect, type PointerPrefs
} from '../../lib/pointerPrefs'
import { addClick, addMove, createEffectState, drawFrame, needsFrame, type EffectConfig } from '../../lib/pointerEffects'
import { effectInk } from '../../lib/pointerInk'
import { canReplaceSystemPointer } from '../../lib/pointerSystem'
import { CLICK_EFFECT_CARDS, MOVE_EFFECT_CARDS, type EffectCardInfo } from './pointerEffectList'
import './PointerSettings.css'

const SIZE_LABELS: Record<CursorSize, string> = { 32: '기본', 48: '크게', 64: '아주 크게' }
const LEVEL_LABELS: Record<EffectLevel, string> = { 1: '약', 2: '보통', 3: '강' }
const PREVIEW_STATES = ['default', 'pointer', 'text'] as const
const PREVIEW_MS = 3000
const PREVIEW_TAIL_MS = 1500

const usePointerPrefs = () => useSyncExternalStore(subscribePointerPrefs, getPointerPrefs)

function useReducedMotion() {
  const query = '(prefers-reduced-motion: reduce)'
  const [reduced, setReduced] = useState(() => matchMedia(query).matches)
  useEffect(() => {
    const list = matchMedia(query)
    const change = () => setReduced(list.matches)
    list.addEventListener('change', change)
    return () => list.removeEventListener('change', change)
  }, [])
  return reduced
}

function Segment<T extends string | number | boolean>({ label, options, value, onChange }: {
  label: string; options: readonly { value: T; label: string }[]; value: T; onChange: (value: T) => void
}) {
  return (
    <div className="theme-filter-tabs appearance-segment" role="radiogroup" aria-label={label}>
      {options.map(option => (
        <button key={String(option.value)} type="button" role="radio" aria-checked={value === option.value}
          className={`theme-filter-tab ${value === option.value ? 'active' : ''}`} onClick={() => onChange(option.value)}>
          {option.label}
        </button>
      ))}
    </div>
  )
}

function SetCard({ set, selected, onPick }: { set: CursorSet; selected: boolean; onPick: () => void }) {
  return (
    <button type="button" role="radio" aria-checked={selected} className="pointer-card" data-set={set.id} onClick={onPick}>
      <span className="pointer-set-preview" aria-hidden="true">
        {PREVIEW_STATES.map((state, index) => (
          <span key={state} className="pointer-set-preview-item">
            {index > 0 && <span className="pointer-set-preview-sep" />}
            <img src={cursorImageUrl(set.id, state, 30)} width={30} height={30} alt="" draggable={false} />
          </span>
        ))}
      </span>
      <span className="pointer-card-name">{set.name}</span>
      <span className="pointer-card-desc">{set.description}</span>
    </button>
  )
}

/** Plays an effect for a few seconds on the card's own small canvas (pointer over or focus) */
function useEffectPreview(group: 'move' | 'click', id: string, reduced: boolean) {
  const boxRef = useRef<HTMLSpanElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const playing = useRef(false)
  const [active, setActive] = useState(false)
  const frame = useRef(0)
  useEffect(() => () => cancelAnimationFrame(frame.current), [])
  const play = () => {
    const box = boxRef.current
    const canvas = canvasRef.current
    if (id === 'none' || playing.current || !box || !canvas) return
    if (reduced && !(group === 'move' && id === 'spot')) return
    const rect = box.getBoundingClientRect()
    const width = Math.round(rect.width)
    const height = Math.round(rect.height)
    canvas.width = width * 2
    canvas.height = height * 2
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(2, 0, 0, 2, 0, 0)
    const { ink, dark } = effectInk(getComputedStyle(document.documentElement))
    const config: EffectConfig = {
      reduced: false, dark, ink, move: group === 'move' ? id as MoveEffect : 'none', click: group === 'click' ? id as ClickEffect : 'none',
      moveLevel: 2, clickLevel: 2, moveOnTerminal: true, clickOnTerminal: true
    }
    const state = createEffectState()
    const previewGhost = config.move === 'ghost' ? ghostCursor(getPointerPrefs().set, 'default', 32) : null
    const clickY = id === 'word' ? height - 3 : height * 0.55
    const start = performance.now()
    let last = start
    let lastClick = -Infinity
    playing.current = true
    setActive(true)
    const step = (now: number) => {
      const dt = Math.max(0, Math.min(40, now - last))
      last = now
      const elapsed = now - start
      if (group === 'move' && elapsed < PREVIEW_MS) {
        const phase = (elapsed % 1500) / 1500
        addMove(state, config.move as MoveEffect, 14 + phase * (width - 28), height / 2 + Math.sin(phase * 9.4) * height * 0.26, now, 2, ink, dark, true,
          previewGhost ? () => previewGhost : undefined)
      } else if (group === 'click' && elapsed < PREVIEW_MS && now - lastClick > 850) {
        lastClick = now
        addClick(state, config.click as ClickEffect, width * 0.5 + (Math.random() - 0.5) * width * 0.3, clickY, now, 2, ink, dark)
      }
      drawFrame(ctx, state, width, height, now, dt, config)
      if (elapsed < PREVIEW_MS || (needsFrame(state, config) && elapsed < PREVIEW_MS + PREVIEW_TAIL_MS)) {
        frame.current = requestAnimationFrame(step)
      } else {
        playing.current = false
        setActive(false)
        ctx.clearRect(0, 0, width, height)
      }
    }
    frame.current = requestAnimationFrame(step)
  }
  return { boxRef, canvasRef, play, active }
}

function EffectCard<T extends string>({ group, info, selected, reduced, onPick }: {
  group: 'move' | 'click'; info: EffectCardInfo<T>; selected: boolean; reduced: boolean; onPick: () => void
}) {
  const { boxRef, canvasRef, play, active } = useEffectPreview(group, info.id, reduced)
  return (
    <button type="button" role="radio" aria-checked={selected} className="pointer-card" data-effect={info.id}
      onClick={() => { onPick(); play() }} onMouseEnter={play} onFocus={play}>
      <span ref={boxRef} className={`pointer-effect-preview${active ? ' is-playing' : ''}`}>
        <span className="pointer-effect-icon" aria-hidden="true" dangerouslySetInnerHTML={{ __html: info.icon }} />
        {info.id !== 'none' && <canvas ref={canvasRef} className="pointer-effect-canvas" aria-hidden="true" />}
      </span>
      <span className="pointer-card-name">{info.name}</span>
      <span className="pointer-card-desc">{info.description}</span>
    </button>
  )
}

function Row({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <div className="appearance-row pointer-row">
      <div className="appearance-label">
        <span>{title}</span>
        <span className="appearance-hint">{hint}</span>
      </div>
      {children}
    </div>
  )
}

const levelOptions = ([1, 2, 3] as const).map(value => ({ value, label: LEVEL_LABELS[value] }))
const terminalOptions = [{ value: true, label: '켜기' }, { value: false, label: '끄기' }] as const
const outsideOptions = [{ value: false, label: '끄기' }, { value: true, label: '켜기' }] as const

export function PointerShapeSettings() {
  const prefs = usePointerPrefs()

  return (
    <div className="pointer-settings">
      <p className="settings-section-desc">앱 안에서 쓰는 화살표, 손가락, 글자 입력 포인터의 모양과 크기를 고릅니다.</p>
      <div className="pointer-cards" role="radiogroup" aria-label="포인터 모양">
        {CURSOR_SETS.map(item => (
          <SetCard key={item.id} set={item} selected={prefs.set === item.id} onPick={() => setPointerPrefs({ set: item.id })} />
        ))}
      </div>
      <Row title="포인터 크기" hint="기본 32px · 크게 48px · 아주 크게 64px (시스템 기본 모양은 크기 설정을 따르지 않음). 크게·아주 크게는 그림이 창 밖으로 나가는 가장자리 근처에서 시스템 포인터로 바뀝니다">
        <Segment label="포인터 크기" value={prefs.size} onChange={size => setPointerPrefs({ size })}
          options={CURSOR_SIZES.map(value => ({ value, label: SIZE_LABELS[value] }))} />
      </Row>
      {canReplaceSystemPointer() && (
        <Row title="다른 프로그램에서도 쓰기" hint="앱이 켜져 있는 동안 Windows 전체의 포인터를 이 세트로 바꿉니다. 끄거나 앱을 닫으면 원래 포인터로 돌아옵니다. 잡기 모양은 Windows 기본 포인터 그대로입니다">
          <Segment label="다른 프로그램에서도 쓰기" value={prefs.outsideApp} options={outsideOptions} onChange={outsideApp => setPointerPrefs({ outsideApp })} />
        </Row>
      )}
      <p className="pointer-note">터미널 안에서는 글자 입력(I-beam) 모양을 유지합니다. 선택한 세트의 I-beam 으로 바뀔 뿐, 모양의 역할은 그대로입니다.</p>
    </div>
  )
}

export function PointerEffectSettings() {
  const prefs = usePointerPrefs()
  const reduced = useReducedMotion()
  const set = (patch: Partial<PointerPrefs>) => setPointerPrefs(patch)
  const reducedNote = reduced && ((prefs.move !== 'none' && prefs.move !== 'spot') || prefs.click !== 'none')

  return (
    <div className="pointer-settings">
      <p className="settings-section-desc">움직일 때와 누를 때의 효과를 따로 고릅니다. 카드에 마우스를 올리면 미리 볼 수 있습니다.</p>
      <h4 className="pointer-subtitle">움직일 때 효과</h4>
      <div className="pointer-cards" role="radiogroup" aria-label="움직일 때 효과">
        {MOVE_EFFECT_CARDS.map(info => (
          <EffectCard key={info.id} group="move" info={info} selected={prefs.move === info.id} reduced={reduced} onPick={() => set({ move: info.id })} />
        ))}
      </div>
      <Row title="세기" hint="입자 수와 크기">
        <Segment label="움직일 때 세기" value={prefs.moveLevel} options={levelOptions} onChange={moveLevel => set({ moveLevel })} />
      </Row>
      <Row title="터미널 위에서" hint="기본 '끄기': 흐르는 로그 위에서 움직이는 장식은 글자 읽기를 방해합니다">
        <Segment label="움직일 때 효과 터미널 위" value={prefs.moveOnTerminal} options={terminalOptions} onChange={moveOnTerminal => set({ moveOnTerminal })} />
      </Row>

      <h4 className="pointer-subtitle">누를 때 효과</h4>
      <div className="pointer-cards" role="radiogroup" aria-label="누를 때 효과">
        {CLICK_EFFECT_CARDS.map(info => (
          <EffectCard key={info.id} group="click" info={info} selected={prefs.click === info.id} reduced={reduced} onPick={() => set({ click: info.id })} />
        ))}
      </div>
      <Row title="세기" hint="입자 수와 크기">
        <Segment label="누를 때 세기" value={prefs.clickLevel} options={levelOptions} onChange={clickLevel => set({ clickLevel })} />
      </Row>
      <Row title="터미널 위에서" hint="기본 '켜기': 클릭은 순간적이라 글자를 가리지 않고, 눌린 위치 확인에 도움이 됩니다">
        <Segment label="누를 때 효과 터미널 위" value={prefs.clickOnTerminal} options={terminalOptions} onChange={clickOnTerminal => set({ clickOnTerminal })} />
      </Row>

      {reducedNote && (
        <p className="pointer-note pointer-note-warn">
          시스템에서 '동작 줄이기'가 켜져 있어 움직이는 효과는 쓰지 않습니다. 포인터 위치 강조는 움직임 없이 따라오고, 누를 때 효과는 제자리에서 옅어지는 고리 하나로 대신합니다.
        </p>
      )}
      <p className="pointer-note">움직일 때와 누를 때는 서로 독립이라 예를 들어 '고양이 발자국 + 톡! 말풍선'처럼 섞을 수 있습니다. 효과는 앱 화면 위에 투명 캔버스 하나만 얹으며 클릭을 막지 않고, 그릴 것이 없으면 멈춥니다.</p>
      <div className="pointer-actions">
        <button type="button" className="theme-action-btn" onClick={() => setPointerPrefs(DEFAULT_POINTER_PREFS)}>포인터 설정 모두 기본값으로</button>
      </div>
    </div>
  )
}
