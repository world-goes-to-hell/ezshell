import { RiHistoryLine, RiCloseLine, RiLoader4Line, RiErrorWarningLine } from 'react-icons/ri'
import { reopenable, type RestoreRecord, type RestoreTab } from '../../lib/restoreTabs'
import type { RestoreOutcome } from '../../lib/restoreTabsRun'
import { keptLocalShells } from '../../lib/localShellAdopt'
import './RestoreTabsBanner.css'

export type RestoreBannerState =
  | { phase: 'ask'; record: RestoreRecord; source: 'update' | 'close' }
  | { phase: 'running'; done: number; total: number }
  | { phase: 'done'; outcome: RestoreOutcome }

interface RestoreTabsBannerProps {
  state: RestoreBannerState
  onRestore: () => void
  onClose: () => void
  /** A quick-connect tab: opens the connect dialog with its login filled in */
  onReconnect: (tab: Extract<RestoreTab, { kind: 'quick' }>) => void
}

const quickTabsOf = (state: RestoreBannerState) =>
  state.phase === 'ask' ? state.record.tabs.filter((tab): tab is Extract<RestoreTab, { kind: 'quick' }> => tab.kind === 'quick')
    : state.phase === 'done' ? state.outcome.quick : []

export function RestoreTabsBanner({ state, onRestore, onClose, onReconnect }: RestoreTabsBannerProps) {
  const quick = quickTabsOf(state)
  const count = state.phase === 'ask' ? reopenable(state.record, keptLocalShells()).length : 0
  const when = state.phase === 'ask' && state.source === 'close' ? '지난번에' : '업데이트 전에'
  return (
    <div className="restore-tabs-banner" role="status">
      <div className="restore-tabs-main">
        {state.phase === 'running'
          ? <RiLoader4Line size={16} className="restore-tabs-spin" aria-hidden="true" />
          : <RiHistoryLine size={16} aria-hidden="true" />}
        <span className="restore-tabs-text">
          {state.phase === 'ask' && (count > 0
            ? `${when} 열려 있던 탭 ${count}개를 다시 열까요?`
            : `${when} 열려 있던 탭은 저장하지 않은 연결이라 자동으로 열 수 없습니다.`)}
          {state.phase === 'running' && `탭을 다시 여는 중… ${state.done}/${state.total}`}
          {state.phase === 'done' && (state.outcome.failed.length === 0
            ? `탭 ${state.outcome.opened}개를 다시 열었습니다.`
            : `탭 ${state.outcome.opened}개를 다시 열었고, ${state.outcome.failed.length}개는 열지 못했습니다.`)}
        </span>
        {state.phase === 'ask' && count > 0 && (
          <button type="button" className="restore-tabs-btn is-primary" onClick={onRestore}>다시 열기</button>
        )}
        {state.phase !== 'running' && (
          <button type="button" className="restore-tabs-btn" onClick={onClose}>
            {state.phase === 'ask' && count > 0 ? '열지 않기' : '닫기'}
          </button>
        )}
        {state.phase === 'done' && (
          <button type="button" className="restore-tabs-close" onClick={onClose} title="닫기" aria-label="닫기">
            <RiCloseLine size={16} />
          </button>
        )}
      </div>
      {state.phase === 'done' && state.outcome.failed.length > 0 && (
        <ul className="restore-tabs-list">
          {state.outcome.failed.map((item, index) => (
            <li key={index}><RiErrorWarningLine size={14} aria-hidden="true" /> <strong>{item.label}</strong> · {item.reason}</li>
          ))}
        </ul>
      )}
      {quick.length > 0 && state.phase !== 'running' && (
        <div className="restore-tabs-quick">
          <span>저장하지 않은 연결 (비밀번호를 다시 입력해 연결):</span>
          {quick.map((tab, index) => (
            <button key={index} type="button" className="restore-tabs-chip" onClick={() => onReconnect(tab)}>
              {tab.title || `${tab.username}@${tab.host}`}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
