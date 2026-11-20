// The model or effort under a local terminal, as a menu (docs/plan/2026-11-20-agent-model-effort-picker.md).
// The list the CLI offered is remembered (lib/agentPickerCache.ts) and shows at once; the refresh button
// reads it from the CLI again. Choosing makes main open the CLI's picker, find that name and press the keys,
// always for this session only; the fresh list it read then replaces the remembered one.
import { useRef, useState, type ReactNode } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { RiCheckLine, RiLoader4Line, RiRefreshLine } from 'react-icons/ri'
import { toast } from '../../stores/toastStore'
import { cachedChoices, isCurrentChoice, rememberChoices, type PickerChoice, type PickerKind, type PickerWhat } from '../../lib/agentPickerCache'

const TITLES = { model: '모델 바꾸기', effort: '노력 수준 바꾸기' } as const
const UNAVAILABLE = '이 앱 버전에서는 쓸 수 없습니다.'

interface AgentPickerMenuProps {
  shellId: string
  what: PickerWhat
  kind: PickerKind
  /** What the usage line shows now (marked in the list) */
  current: string | null
  /** The model in use: Codex's levels are remembered per model */
  model: string | null
  className: string
  children: ReactNode
}

export function AgentPickerMenu({ shellId, what, kind, current, model, className, children }: AgentPickerMenuProps) {
  const [open, setOpen] = useState(false)
  const [choices, setChoices] = useState<PickerChoice[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [applying, setApplying] = useState<string | null>(null)
  // The menu is still the one that asked (closed meanwhile: a late answer only updates the memory)
  const openRef = useRef(false)
  const api = window.electronAPI

  const keep = (fresh: PickerChoice[]) => {
    const list = fresh.map(({ label, description }) => ({ label, description }))
    rememberChoices(kind, what, model, list)
    if (openRef.current) setChoices(list)
  }

  const load = async () => {
    if (loading || applying) return
    setLoading(true)
    try {
      const result = await api.agentPickerList?.(shellId, what)
      if (result?.ok) keep(result.options)
      else {
        toast.error('목록을 불러오지 못했습니다', result && !result.ok ? result.error : UNAVAILABLE)
        if (!cachedChoices(kind, what, model)) close()
      }
    } finally {
      setLoading(false)
    }
  }

  const show = () => {
    openRef.current = true
    setOpen(true)
    const remembered = cachedChoices(kind, what, model)
    setChoices(remembered)
    if (!remembered) void load()
  }

  const close = () => {
    openRef.current = false
    setOpen(false)
  }

  const choose = async (label: string) => {
    if (applying || loading) return
    setApplying(label)
    try {
      const result = await api.agentPickerApply?.(shellId, what, label)
      if (result?.options) keep(result.options)
      if (result?.ok) {
        close()
        return
      }
      toast.error('바꾸지 못했습니다', result && !result.ok ? result.error : UNAVAILABLE)
      // A name the CLI no longer offers: the menu stays with the fresh list
      if (!(result && !result.ok && result.reason === 'missing')) close()
    } finally {
      setApplying(null)
    }
  }

  return (
    <DropdownMenu.Root
      open={open}
      modal={false}
      onOpenChange={next => {
        if (next) show()
        // Main is pressing the CLI's keys: the menu stays until it is done
        else if (!applying) close()
      }}
    >
      <DropdownMenu.Trigger asChild>
        <button type="button" className={`${className} agent-picker-trigger`} title={`${TITLES[what]} (이 세션에만)`}>
          {children}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="agent-picker-menu" side="top" align="start" sideOffset={4} collisionPadding={8}>
          <div className="agent-picker-head">
            <DropdownMenu.Label className="agent-picker-label">
              {TITLES[what]} <span className="agent-picker-hint">이 세션에만 적용</span>
            </DropdownMenu.Label>
            <DropdownMenu.Item
              className="agent-picker-refresh"
              disabled={loading || applying !== null}
              onSelect={event => {
                event.preventDefault()
                void load()
              }}
              aria-label="목록 새로 불러오기"
              title="에이전트에서 목록을 다시 불러옵니다"
            >
              <RiRefreshLine className={loading ? 'agent-picker-spin' : undefined} aria-hidden="true" />
            </DropdownMenu.Item>
          </div>
          {!choices && (
            <div className="agent-picker-status" role="status">
              <RiLoader4Line className="agent-picker-spin" aria-hidden="true" /> 에이전트의 선택 화면에서 목록을 읽는 중…
            </div>
          )}
          {choices?.map(choice => (
            <DropdownMenu.Item
              key={choice.label}
              className="agent-picker-item"
              disabled={applying !== null || loading}
              onSelect={event => {
                // The menu stays while main presses the keys
                event.preventDefault()
                void choose(choice.label)
              }}
            >
              <span className="agent-picker-check" aria-hidden="true">
                {applying === choice.label
                  ? <RiLoader4Line className="agent-picker-spin" />
                  : isCurrentChoice(choice.label, current) ? <RiCheckLine /> : null}
              </span>
              <span className="agent-picker-text">
                <span className="agent-picker-name">{choice.label}</span>
                {choice.description && <span className="agent-picker-detail">{choice.description}</span>}
              </span>
            </DropdownMenu.Item>
          ))}
          {choices && loading && <div className="agent-picker-status is-inline" role="status">목록을 새로 불러오는 중…</div>}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
