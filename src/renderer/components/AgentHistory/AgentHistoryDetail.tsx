import { RiFileCopyLine, RiFolderOpenLine, RiPlayLine } from 'react-icons/ri'
import type { AgentHistoryDetail as Detail, AgentHistorySession } from '../../types'
import { AGENT_LABELS, resumeCommand } from '../../lib/agentHistory'
import { toast } from '../../stores/toastStore'

export type DetailState =
  | { status: 'loading' }
  | { status: 'ready'; detail: Detail }
  | { status: 'error'; message: string }

const isWindowsHost = () => /win/i.test(navigator.platform || navigator.userAgent)

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success('복사했습니다', what)
  } catch {
    toast.error('복사하지 못했습니다', what)
  }
}

function formatDate(time: number | null): string | null {
  if (time === null) return null
  return new Date(time).toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' })
}

interface Props {
  session: AgentHistorySession
  state: DetailState | undefined
  shellId: string
  onResume: (session: AgentHistorySession) => void
}

/** The expanded part of a row: where and what, the first prompt, the latest turns and the actions */
export function AgentHistoryDetail({ session, state, shellId, onResume }: Props) {
  const command = resumeCommand(session, isWindowsHost())
  const openFolder = async () => {
    const result = await window.electronAPI.agentHistoryOpenFolder?.(shellId, session.key)
    if (result && !result.success) toast.error('폴더를 열지 못했습니다', result.error)
  }
  const facts: Array<[string, string | null]> = [
    ['폴더', session.cwd],
    ['브랜치', session.branch],
    ['모델', session.model],
    ['시작', formatDate(session.created)],
    ['세션 ID', session.id]
  ]

  return (
    <div className="agent-history-detail">
      <dl className="agent-history-facts">
        {facts.filter(([, value]) => value).map(([name, value]) => (
          <div key={name}>
            <dt>{name}</dt>
            <dd title={value ?? undefined}>{value}</dd>
          </div>
        ))}
      </dl>

      <div className="agent-history-actions">
        <button type="button" className="agent-history-primary" disabled={!session.cwd} onClick={() => onResume(session)}
          title={session.cwd ? '이 세션의 폴더에서 로컬 터미널 탭을 열고 이어서 실행합니다' : '폴더를 알 수 없는 세션입니다'}>
          <RiPlayLine size={14} aria-hidden="true" />
          이어서 실행
        </button>
        <button type="button" disabled={!command} onClick={() => command && void copy(command, '재개 명령')} title={command ?? undefined}>
          <RiFileCopyLine size={14} aria-hidden="true" />
          재개 명령 복사
        </button>
        <button type="button" onClick={() => void copy(session.id, '세션 ID')}>세션 ID 복사</button>
        <button type="button" disabled={!session.cwd} onClick={() => void openFolder()}>
          <RiFolderOpenLine size={14} aria-hidden="true" />
          폴더 열기
        </button>
      </div>

      {state?.status === 'loading' && <p className="agent-history-note">기록을 읽는 중…</p>}
      {state?.status === 'error' && <p className="agent-history-note is-error">{state.message}</p>}
      {state?.status === 'ready' && (
        <>
          {state.detail.firstPrompt && (
            <section className="agent-history-section">
              <header>
                <h3>첫 질문</h3>
                <button type="button" className="agent-history-link" onClick={() => void copy(state.detail.firstPrompt ?? '', '첫 질문')}>복사</button>
              </header>
              <pre className="agent-history-text">{state.detail.firstPrompt}</pre>
            </section>
          )}
          <section className="agent-history-section">
            <header><h3>최근 대화</h3></header>
            {state.detail.turnsUnavailable ? (
              <p className="agent-history-note">기록이 너무 커서 최근 대화를 읽지 않았습니다.</p>
            ) : state.detail.turns.length === 0 ? (
              <p className="agent-history-note">보여 줄 대화가 없습니다.</p>
            ) : (
              <ol className="agent-history-turns">
                {state.detail.turns.map((turn, index) => (
                  <li key={index} className={`agent-history-turn is-${turn.role}`}>
                    <span className="agent-history-role">{turn.role === 'user' ? '나' : AGENT_LABELS[session.agent]}</span>
                    <pre className="agent-history-text">{turn.text}</pre>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </>
      )}
    </div>
  )
}
