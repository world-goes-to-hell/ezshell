// A run preset that crashed (scene 6): an in-app notice with its last error lines and 로그 보기 /
// 다시 실행 / 에이전트에게 보내기. Each crash is told once (runPresetStore's crashKey); Windows notices are
// main's. The send dialog (scene 7) picks an agent of the same project.
import { useEffect, useMemo, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { RiAlertFill, RiCloseLine, RiFileList3Line, RiRefreshLine, RiRobot2Line, RiSendPlaneFill } from 'react-icons/ri'
import { useAgentMessagesStore } from '../Terminal/AgentMessages'
import { AgentIdentityBadge } from '../ui/AgentIdentity'
import { agentIdentityStatus } from '../../lib/agentIdentity'
import { folderLabel, pathKey } from '../../lib/localWorkspaceTree'
import { agentActionNotice, agentNoticeName, IDLE_STATE, runCommandLabel, sendPreview, withSubject, type RunErrorGroup, type RunPreset, type RunState } from '../../lib/runPresets'
import {
  dismissAgentNotice, dismissCrash, fetchRunErrors, revealRunShell, runPresetAction, runPresetApi, turnOffAgentControl,
  useRunPresets, type AgentActionNotice, type CrashNotice
} from '../../stores/runPresetStore'
import { toast } from '../../stores/toastStore'
import './RunPresets.css'

interface Sending { notice: CrashNotice; preset: RunPreset; state: RunState; group?: RunErrorGroup }

export function RunCrashNotices() {
  const notices = useRunPresets(state => state.notices)
  const agentNotices = useRunPresets(state => state.agentNotices)
  const [sending, setSending] = useState<Sending | null>(null)
  if (!notices.length && !agentNotices.length && !sending) return null
  return (<>
    <div className="run-crash-notices" role="region" aria-label="실행 구성 알림">
      {agentNotices.slice(-2).map(notice => <AgentActionCard key={notice.key} notice={notice} />)}
      {notices.slice(-3).map(notice => <CrashCard key={notice.key} notice={notice} onSend={setSending} />)}
    </div>
    {sending && <RunSendDialog {...sending} onClose={() => setSending(null)} />}
  </>)
}

function CrashCard({ notice, onSend }: { notice: CrashNotice; onSend: (sending: Sending) => void }) {
  const project = useRunPresets(state => state.worktrees[notice.worktreeKey] ?? state.worktrees[pathKey(notice.folder)])
  const preset = project?.presets.find(item => item.id === notice.id)
  const state = project?.states[notice.id] ?? IDLE_STATE
  const [group, setGroup] = useState<RunErrorGroup | undefined>()
  useEffect(() => {
    let active = true
    void fetchRunErrors(notice.folder, notice.id).then(groups => { if (active) setGroup(groups[groups.length - 1]) })
    return () => { active = false }
  }, [notice.folder, notice.id, notice.key])
  if (!preset) return null
  const ranFor = state.startedAt ? Math.max(0, Math.round(((state.readyAt ?? Date.now()) - state.startedAt) / 1000)) : null
  const detail = [state.exitCode === null || state.exitCode === undefined ? '종료' : `종료 코드 ${state.exitCode}`,
    ranFor === null ? '' : `시작한 지 ${ranFor}초`].filter(Boolean).join(' · ')
  return (
    <div className="run-crash" role="alert" data-run-preset={preset.id}>
      <div className="run-crash-title">
        <RiAlertFill size={16} aria-hidden="true" />
        <span>{withSubject(preset.name)} 멈췄습니다 · {folderLabel(notice.folder)}</span>
        <button type="button" className="run-crash-close" onClick={() => dismissCrash(notice.key)} aria-label="알림 닫기" title="닫기">
          <RiCloseLine size={14} />
        </button>
      </div>
      <div className="run-crash-detail">{detail}</div>
      {group && group.lines.length > 0 && <pre className="run-crash-log">{group.lines.slice(0, 12).join('\n')}</pre>}
      <div className="run-crash-actions">
        <button type="button" className="btn-secondary modal-btn" disabled={!state.shellId}
          onClick={() => state.shellId && revealRunShell({ shellId: state.shellId, label: preset.name, errorLine: group?.lines.find(line => line.trim()) })}>
          <RiFileList3Line size={13} aria-hidden="true" /> 로그 보기
        </button>
        <button type="button" className="btn-secondary modal-btn" onClick={() => {
          dismissCrash(notice.key)
          void runPresetAction(notice.folder, 'restart', preset.id)
        }}>
          <RiRefreshLine size={13} aria-hidden="true" /> 다시 실행
        </button>
        <button type="button" className="btn-primary modal-btn" disabled={typeof runPresetApi().runPresetSend !== 'function'}
          onClick={() => onSend({ notice, preset, state, group })}>
          <RiSendPlaneFill size={13} aria-hidden="true" /> 에이전트에게 보내기
        </button>
      </div>
    </div>
  )
}

/**
 * The first time an agent ran, restarted or stopped a preset: who did what, and `끄기` to take agent
 * control away from that preset (it stays on the row as "codex-5 가 재기동 · N초 전" either way)
 */
function AgentActionCard({ notice }: { notice: AgentActionNotice }) {
  const project = useRunPresets(state => state.worktrees[notice.worktreeKey]
    ?? Object.values(state.worktrees).find(item => item.projectKey === notice.projectKey))
  const agent = useAgentMessagesStore(store => store.snapshot.agents.find(item => item.id === notice.action.by))
  const preset = project?.presets.find(item => item.id === notice.id)
  const [busy, setBusy] = useState(false)
  if (!preset) return null
  return (
    <div className="run-crash run-agent-notice" role="status" data-run-preset={preset.id}>
      <div className="run-crash-title">
        <RiRobot2Line size={16} aria-hidden="true" />
        <span>{agentActionNotice(agentNoticeName(agent, notice.action.by), preset.name, notice.action.action)}</span>
      </div>
      <div className="run-crash-detail">이 구성은 같은 프로젝트의 에이전트가 실행·재기동·중지하고 로그를 읽을 수 있습니다.</div>
      <div className="run-crash-actions">
        <button type="button" className="btn-secondary modal-btn" disabled={busy || !preset.agentControl} onClick={async () => {
          setBusy(true)
          if (await turnOffAgentControl(notice.folder, preset)) dismissAgentNotice(notice.key)
          setBusy(false)
        }}>끄기</button>
        <button type="button" className="btn-secondary modal-btn" onClick={() => dismissAgentNotice(notice.key)}>닫기</button>
      </div>
    </div>
  )
}

/** Inside one of the project's folders (its worktrees live elsewhere: the project's key folder and the agent's own) */
const within = (path: string, root: string) => {
  const a = pathKey(path)
  const b = pathKey(root)
  return a === b || a.startsWith(b.endsWith('/') ? b : `${b}/`)
}

function RunSendDialog({ notice, preset, state, group, onClose }: Sending & { onClose: () => void }) {
  const snapshot = useAgentMessagesStore(store => store.snapshot)
  const projectRoots = useRunPresets(store => store.projectRoots[notice.projectKey])
  // Every worktree of the project, as the sidebar lists them (and the card's own folder)
  const roots = useMemo(() => [notice.folder, notice.projectKey, ...(projectRoots ?? [])].filter(Boolean), [notice.folder, notice.projectKey, projectRoots])
  // The text main will send (folders relative to the project). When main can say it, sending waits for it:
  // a preview made here could differ from what goes out.
  const askPreview = runPresetApi().runPresetSendPreview
  const [mainPreview, setMainPreview] = useState<string | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  useEffect(() => {
    if (!askPreview) return
    let active = true
    setMainPreview(null)
    setPreviewError(null)
    askPreview(notice.folder, preset.id).then(result => {
      if (!active) return
      if (typeof result?.text === 'string') setMainPreview(result.text)
      else setPreviewError(result?.error || '보낼 내용을 만들지 못했습니다.')
    }).catch(() => { if (active) setPreviewError('보낼 내용을 만들지 못했습니다.') })
    return () => { active = false }
  }, [askPreview, notice.folder, preset.id])
  const previewReady = !askPreview || mainPreview !== null
  // Agents bound to a shell of this project (an agent without a shell cannot take it: Aside and the like)
  const agents = useMemo(() => snapshot.agents.filter(agent => agent.active && agent.shellId && agent.cwd && roots.some(root => within(agent.cwd, root))), [snapshot.agents, roots])
  const [picked, setPicked] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [sending, setSending] = useState(false)
  const target = picked && agents.some(agent => agent.id === picked) ? picked : agents[0]?.id ?? null
  const label = runCommandLabel(preset)

  const send = async () => {
    const run = runPresetApi().runPresetSend
    if (!target || !run) return
    setSending(true)
    try {
      const result = await run(notice.folder, preset.id, target, note.trim())
      if (result?.ok !== true) {
        toast.error('에이전트에게 보내지 못했습니다', result?.error)
        return
      }
      toast.success('에이전트에게 보냈습니다', target)
      dismissCrash(notice.key)
      onClose()
    } catch {
      toast.error('에이전트에게 보내지 못했습니다')
    } finally {
      setSending(false)
    }
  }

  return (
    <Dialog.Root open onOpenChange={open => { if (!open && !sending) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="modal-content run-send-dialog" aria-describedby="run-send-note">
          <Dialog.Title className="modal-title"><RiSendPlaneFill size={17} aria-hidden="true" /> 오류를 보낼 에이전트</Dialog.Title>
          <div className="run-send-agents" role="radiogroup" aria-label="받을 에이전트">
            {agents.length === 0 && <p className="run-preset-hint">이 프로젝트의 셸에서 도는 에이전트가 없습니다.</p>}
            {agents.map(agent => (
              <label key={agent.id} className="run-send-agent" data-on={agent.id === target || undefined}>
                <input type="radio" name="run-send-agent" checked={agent.id === target} onChange={() => setPicked(agent.id)} />
                <AgentIdentityBadge agent={agent} showProvider />
                <span className="run-send-agent-state">{agentIdentityStatus(agent).label}</span>
              </label>
            ))}
          </div>
          <pre className="run-crash-log run-send-preview" data-ready={previewReady || undefined}>
            {askPreview ? (mainPreview ?? previewError ?? '보낼 내용을 만드는 중…') : sendPreview(preset, state, group, label)}
          </pre>
          <textarea className="run-send-note-input" rows={2} value={note} maxLength={2000} placeholder="덧붙일 말 (선택)"
            onChange={event => setNote(event.target.value)} aria-label="덧붙일 말" />
          <p id="run-send-note" className="run-preset-hint">보내는 것: 서버 이름·폴더·명령·종료 코드, 마지막 오류 묶음(최대 80줄). 같은 프로젝트의 에이전트만 위에 나옵니다.</p>
          <div className="modal-actions">
            <button type="button" className="btn-secondary modal-btn" onClick={onClose} disabled={sending}>취소</button>
            <button type="button" className="btn-primary modal-btn" onClick={() => void send()} disabled={sending || !target || !previewReady}>
              <RiSendPlaneFill size={13} aria-hidden="true" /> 보내기
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
