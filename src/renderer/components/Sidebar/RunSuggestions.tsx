// What a failed run's logs suggest (stage 2: 실패 진단과 제안), opened from a preset's card: each finding in
// words, and for the two main can apply (a replacement for a blocked Maven repository; the project's
// settings.xml as the user settings) a button the user presses after reading. Nothing is applied by itself.
// An agent's proposal (run_propose) only fills the fields of the finding it names (the address, the jar)
// and says who sent it and why; the user still presses the button, or throws the proposal away.
import { useEffect, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { RiAlertLine, RiLightbulbLine, RiStethoscopeLine } from 'react-icons/ri'
import {
  APPLIED_NOTE, cleanProposals, cleanSuggestions, jarSource, proposalHost, proposalSummary, replacementUrl, SIMPLE_APPLIES, suggestionTitle, USER_SETTINGS_WARNING,
  type RunSuggestion
} from '../../lib/runSuggestions'
import { reloadAge } from '../../lib/runPresets'
import type { RunProposal } from '../../types'
import { reloadProjectPresets } from '../../stores/runPresetStore'
import { toast } from '../../stores/toastStore'
import './RunSuggestions.css'

export function RunSuggestionsDialog({ folder, presetId, presetName, proposals, onClose }: {
  /** The worktree the preset ran in */
  folder: string
  presetId: string
  presetName: string
  /** Agents' pending proposals for this run (newest first) */
  proposals?: RunProposal[]
  onClose: () => void
}) {
  const [pending, setPending] = useState(() => cleanProposals(proposals))
  const proposalFor = (id: string) => pending.find(proposal => proposal.suggestion.id === id)
  // Closing only keeps a proposal waiting; 버리기 tells main (and the agent) it was declined
  const dismiss = async (proposal: RunProposal) => {
    const drop = window.electronAPI.runPresetDismissProposal
    if (!drop || busy) return
    setBusy(true)
    try {
      const result = await drop(folder, presetId, proposal.id)
      if (result?.ok === false) { toast.error('제안을 버리지 못했습니다', result.error); return }
      setPending(current => current.filter(item => item.id !== proposal.id))
      await reloadProjectPresets(folder)
    } catch {
      toast.error('제안을 버리지 못했습니다')
    } finally {
      setBusy(false)
    }
  }
  // null while asked
  const [items, setItems] = useState<RunSuggestion[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let active = true
    const ask = window.electronAPI.runPresetDiagnosis
    if (!ask) { setItems([]); return }
    ask(folder, presetId).then(result => {
      if (!active) return
      if (result?.ok === false) setError(result.error || '진단하지 못했습니다.')
      setItems(cleanSuggestions(result?.suggestions))
    }, () => { if (active) { setError('진단하지 못했습니다.'); setItems([]) } })
    return () => { active = false }
  }, [folder, presetId])

  const apply = async (item: RunSuggestion, url?: string, jarId?: string) => {
    const send = window.electronAPI.runPresetApplySuggestion
    if (!send || busy) return
    setBusy(true)
    try {
      const result = await send(folder, presetId, { id: item.id, ...(url ? { replacementUrl: url } : {}), ...(jarId ? { jarId } : {}) })
      if (result?.ok === false) {
        toast.error('제안을 적용하지 못했습니다', result.error)
        return
      }
      toast.success(APPLIED_NOTE)
      await reloadProjectPresets(folder)
      onClose()
    } catch {
      toast.error('제안을 적용하지 못했습니다')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog.Root open onOpenChange={open => { if (!open && !busy) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="modal-content run-suggestions-dialog" aria-describedby="run-suggestions-lead">
          <Dialog.Title className="modal-title"><RiStethoscopeLine size={18} aria-hidden="true" /> 실행 진단 · {presetName}</Dialog.Title>
          <p id="run-suggestions-lead" className="run-preset-hint">마지막 실행의 로그에서 찾은 것입니다. 적용은 내용을 보고 직접 눌러야 하며, 적용하면 다음 실행 때 한 번 더 확인합니다.</p>
          {error && <p className="run-preset-error" role="alert">{error}</p>}
          {items === null && <p className="run-preset-hint">진단하는 중…</p>}
          {items?.length === 0 && !error && <p className="run-suggestions-empty">로그에서 알려진 문제를 찾지 못했습니다.</p>}
          {pending.length > 0 && <p className="run-preset-hint">에이전트의 제안은 칸만 미리 채웁니다. 적용은 내용을 보고 직접 눌러 주세요.</p>}
          {items && items.length > 0 && (
            <ul className="run-suggestions">
              {items.map(item => {
                const proposal = proposalFor(item.id)
                return <SuggestionItem key={proposal?.id ?? item.id} item={item} busy={busy} onApply={apply} proposal={proposal} onDismiss={dismiss} />
              })}
            </ul>
          )}
          {/* Proposals about a finding the logs no longer show: only to read and throw away */}
          {items && pending.filter(proposal => !items.some(item => item.id === proposal.suggestion.id)).map(proposal => (
            <div key={proposal.id} className="run-suggestion" data-stale>
              <strong className="run-suggestion-title">지금 진단에 없는 제안</strong>
              <ProposalBox proposal={proposal} busy={busy} onDismiss={dismiss} showWhat />
            </div>
          ))}
          <div className="modal-actions">
            <button type="button" className="btn-secondary modal-btn" onClick={onClose} disabled={busy}>닫기</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function SuggestionItem({ item, busy, onApply, proposal, onDismiss }: {
  item: RunSuggestion; busy: boolean; onApply: (item: RunSuggestion, url?: string, jarId?: string) => void
  proposal?: RunProposal; onDismiss: (proposal: RunProposal) => void
}) {
  // An agent's proposal fills the address or picks the jar; nothing else
  const [url, setUrl] = useState(item.apply === 'mavenMirror' ? proposal?.suggestion.replacementUrl ?? '' : '')
  // tomcatJar: the proposed jar, or the only candidate when there is one, otherwise the user picks
  const proposedJar = proposal?.suggestion.jarId && item.jars?.some(candidate => candidate.id === proposal.suggestion.jarId) ? proposal.suggestion.jarId : null
  const [jar, setJar] = useState<string | null>(proposedJar ?? (item.jars?.length === 1 ? item.jars[0].id : null))
  const [understood, setUnderstood] = useState(false)
  const checked = url ? replacementUrl(url) : null
  return (
    <li className="run-suggestion" data-kind={item.kind} data-apply={item.apply}>
      <strong className="run-suggestion-title">{suggestionTitle(item)}</strong>
      <p className="run-suggestion-message">{item.message}</p>
      {proposal && <ProposalBox proposal={proposal} busy={busy} onDismiss={onDismiss} />}
      {item.apply === 'mavenMirror' && (
        <div className="run-suggestion-apply">
          <label htmlFor={`run-suggestion-url-${item.id}`}>대신 쓸 저장소 주소</label>
          <input id={`run-suggestion-url-${item.id}`} value={url} placeholder="https://… 또는 file:///C:/maven-repo"
            onChange={event => setUrl(event.target.value)} spellCheck={false} autoComplete="off" />
          {checked && 'error' in checked && <small className="run-preset-warn">{checked.error}</small>}
          {/* Where it will point, right before the press (a look-alike domain shows as xn--…) */}
          {checked && 'url' in checked && proposalHost(checked.url) && (
            <small className="run-suggestion-host">적용할 곳: <strong>{proposalHost(checked.url)}</strong></small>
          )}
          <small className="run-preset-hint">이 프로젝트 전용 Maven 설정에만 들어갑니다 (~/.m2/settings.xml 은 그대로).</small>
          <button type="button" className="btn-primary modal-btn" disabled={busy || !checked || 'error' in checked}
            onClick={() => { if (checked && 'url' in checked) onApply(item, checked.url) }}>이 주소로 대체</button>
        </div>
      )}
      {/* The jars that hold the missing class: to pick and add for a Tomcat preset (tomcatJar), otherwise only
          shown (another kind of run, Tomcat 6); a search cut short is said even when nothing was found */}
      {item.jars && (item.jars.length > 0 || item.jarSearchIncomplete) && (() => {
        const choose = item.apply === 'tomcatJar'
        const jars = item.jars
        return (
          <div className="run-suggestion-apply" {...(choose ? { role: 'radiogroup', 'aria-label': '추가할 jar' } : {})}>
            {jars.length > 0 && (
              <span className="run-suggestion-label">
                {choose && jars.length > 1 ? `이 클래스가 든 jar ${jars.length}개 — 하나를 고르세요` : `이 클래스가 든 jar${jars.length > 1 ? ` ${jars.length}개` : ''}`}
              </span>
            )}
            {jars.map(candidate => {
              const text = (
                <span className="run-suggestion-jar-text">
                  <code title={candidate.path}>{candidate.path}</code>
                  {(candidate.coordinate || candidate.source) && (
                    <small>{[candidate.coordinate, jarSource(candidate.source)].filter(Boolean).join(' · ')}</small>
                  )}
                </span>
              )
              return choose ? (
                <label key={candidate.id} className="run-suggestion-jar" data-on={jar === candidate.id || undefined}>
                  <input type="radio" name={`run-suggestion-jar-${item.id}`} checked={jar === candidate.id} onChange={() => setJar(candidate.id)} />
                  {text}
                </label>
              ) : (
                <div key={candidate.id} className="run-suggestion-jar" data-readonly>{text}</div>
              )
            })}
            {item.jarSearchIncomplete && (
              <small className="run-preset-warn">
                {jars.length ? '찾을 곳이 많아 일부는 끝까지 찾지 못했습니다.' : '찾을 곳이 많아 끝까지 찾지 못했고, 찾은 jar 가 없습니다.'} 원하는 jar 가 없으면 프로젝트 lib 폴더에 넣고 다시 진단해 주세요.
              </small>
            )}
            {choose ? (<>
              <small className="run-preset-hint">이 구성의 추가 lib 에 더해 실행할 때 /WEB-INF/lib 로 붙입니다. 프로젝트 파일은 바꾸지 않습니다.</small>
              <button type="button" className="btn-primary modal-btn" disabled={busy || !jar} onClick={() => { if (jar) onApply(item, undefined, jar) }}>
                추가 lib 으로 더하기
              </button>
            </>) : jars.length > 0 && (
              <small className="run-preset-hint">이 실행에는 앱이 붙일 수 없습니다. 이 jar 를 프로젝트의 lib 이나 의존성에 넣어 주세요.</small>
            )}
          </div>
        )
      })()}
      {(item.apply === 'mavenPinned' || item.apply === 'mavenRunner') && (
        <div className="run-suggestion-apply">
          <small className="run-preset-hint">이 구성의 Maven 설정을 바꿉니다. 다음 실행 때 바뀐 내용을 한 번 더 확인합니다.</small>
          <button type="button" className="btn-primary modal-btn" disabled={busy} onClick={() => onApply(item)}>{SIMPLE_APPLIES[item.apply]}</button>
        </div>
      )}
      {item.apply === 'mavenUserSettings' && (
        <div className="run-suggestion-apply">
          <div className="run-suggestion-warning" role="note">
            <RiAlertLine size={15} aria-hidden="true" />
            <span>{USER_SETTINGS_WARNING}</span>
          </div>
          <label className="run-suggestion-check">
            <input type="checkbox" checked={understood} onChange={event => setUnderstood(event.target.checked)} />
            <span>위 설정이 빠진다는 것을 확인했습니다</span>
          </label>
          <button type="button" className="btn-primary modal-btn" disabled={busy || !understood} onClick={() => onApply(item)}>
            프로젝트 설정으로 다시 실행하게 하기
          </button>
        </div>
      )}
    </li>
  )
}

/** Who proposed what and why (plain text), with the full address and its host for a repository */
function ProposalBox({ proposal, busy, onDismiss, showWhat }: { proposal: RunProposal; busy: boolean; onDismiss: (proposal: RunProposal) => void; showWhat?: boolean }) {
  const url = proposal.suggestion.apply === 'mavenMirror' ? proposal.suggestion.replacementUrl : undefined
  const host = proposalHost(url)
  return (
    <div className="run-proposal" data-proposal={proposal.id}>
      <div className="run-proposal-head">
        <RiLightbulbLine size={13} aria-hidden="true" />
        <span><strong>{proposal.by}</strong> 의 제안{proposal.at ? ` · ${reloadAge(proposal.at, Date.now())}` : ''}</span>
        <button type="button" className="run-preset-link" onClick={() => onDismiss(proposal)} disabled={busy}>버리기</button>
      </div>
      {showWhat && <p className="run-proposal-url">{proposalSummary(proposal)}</p>}
      {proposal.note && <p className="run-proposal-note">{proposal.note}</p>}
      {url && (
        <p className="run-proposal-url">
          제안한 주소{host && <> (<strong>{host}</strong>)</>}: <code>{url}</code>
        </p>
      )}
    </div>
  )
}
