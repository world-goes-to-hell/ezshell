import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { RiArrowLeftLine, RiArrowRightLine, RiCheckLine, RiLoader4Line, RiQuestionLine, RiSendPlane2Line, RiTerminalBoxLine } from 'react-icons/ri'
import type { AgentAskQuestion, AgentChatItem } from '../../types'
import { answerOf, answersOf, answerText, emptyDraft, otherProblem, pick, toggleOther, type AskDraft } from '../../lib/askQuestion'
import { useAskQuestionStore } from '../../stores/askQuestionStore'
import { toast } from '../../stores/toastStore'
import { isApprovalClick, isApprovalShortcut, useApprovalArming } from './useApprovalArming'
import './AskQuestionCard.css'

/**
 * Claude's AskUserQuestion answered in the chat's own design (docs/plan/2026-11-23-chat-claude-question-card.md).
 * A step per question, a review when there is more than one, then main presses the keys of Claude's dialog.
 * The only question, a single choice, is sent with its choice (as its number does in the terminal).
 */
export function AskQuestionCard({ shellId, item, onTerminal }: { shellId: string; item: AgentChatItem; onTerminal: () => void }) {
  const questions = item.tool?.question?.questions ?? []
  const [drafts, setDrafts] = useState<AskDraft[]>(() => questions.map(emptyDraft))
  const [step, setStep] = useState(0)
  const sending = useAskQuestionStore(state => state.sending.get(shellId))
  const setSending = useAskQuestionStore(state => state.setSending)
  const answerInTerminal = useAskQuestionStore(state => state.answerInTerminal)
  const { armed, canActivate } = useApprovalArming()
  const canClick = (event: MouseEvent<HTMLButtonElement>) => canActivate() && isApprovalClick(event)
  const busy = sending?.itemId === item.id
  // With previews a choice is looked at before it is sent (in the CLI the number only shows its preview too)
  const direct = questions.length === 1 && !questions[0].multiSelect && !questions[0].preview
  const reviewing = !direct && questions.length > 1 && step === questions.length
  const question = questions[Math.min(step, questions.length - 1)]
  const draft = drafts[Math.min(step, questions.length - 1)] ?? emptyDraft()
  // The choice whose preview shows: the one pointed at or focused, else the chosen one, else the first
  const [looked, setLooked] = useState<number | null>(null)
  const shownPreview = question?.preview ? question.options[looked ?? draft.picks[0] ?? 0]?.preview : undefined
  useEffect(() => setLooked(null), [step])

  const toTerminal = () => {
    answerInTerminal(shellId, item.id)
    onTerminal()
  }

  const send = async (all: AskDraft[]) => {
    const answers = answersOf(questions, all)
    if (!answers || useAskQuestionStore.getState().sending.get(shellId)?.itemId === item.id) return
    if (!window.electronAPI.agentChatAnswerQuestions) {
      toast.error('답하지 못했습니다', '이 앱 버전에서는 쓸 수 없습니다.')
      return
    }
    setSending(shellId, { itemId: item.id, state: 'sending' })
    const result = await window.electronAPI.agentChatAnswerQuestions(shellId, item.id, answers)
    if (result.ok) {
      setSending(shellId, { itemId: item.id, state: 'sent' })
      return
    }
    setSending(shellId, null)
    toast.error('답하지 못했습니다', result.error)
    // Keys may have stopped halfway: the dialog is finished in the terminal, where it was left
    if (result.reason !== 'answered') toTerminal()
  }

  const update = (next: AskDraft) => setDrafts(all => all.map((entry, index) => (index === step ? next : entry)))
  const choose = (index: number) => {
    const next = pick(question, draft, index)
    update(next)
    if (direct) void send([next])
    // A single choice moves on, as the CLI does (not with previews: the picked one's preview is looked at)
    else if (!question.multiSelect && !question.preview) setStep(step + 1)
  }
  const complete = answerOf(question, draft) !== null
  const next = () => {
    if (!complete) return
    if (questions.length === 1) void send(drafts)
    else setStep(step + 1)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!isApprovalShortcut(event) || !canActivate() || busy) return
    if (event.target instanceof HTMLInputElement) {
      if (event.key !== 'Enter') return
      event.preventDefault()
      next()
      return
    }
    if (reviewing) {
      if (event.target === event.currentTarget && event.key === 'Enter') {
        event.preventDefault()
        void send(drafts)
      }
      return
    }
    // Number keys pick, as in the terminal
    if (/^[1-9]$/.test(event.key) && Number(event.key) <= question.options.length) {
      event.preventDefault()
      choose(Number(event.key) - 1)
    }
  }

  if (!question) return null
  if (busy) {
    return (
      <div className="agent-chat-approval agent-ask" role="status">
        <div className="agent-ask-sending">
          {sending.state === 'sending' ? <RiLoader4Line className="agent-chat-spin" aria-hidden /> : <RiCheckLine aria-hidden />}
          {sending.state === 'sending' ? '답을 보내는 중…' : '답을 보냈습니다'}
        </div>
      </div>
    )
  }

  const problem = otherProblem(draft)
  return (
    <div className="agent-chat-approval agent-ask" role="group" aria-label="Claude 의 질문" tabIndex={0} onKeyDown={onKeyDown}>
      <div className="agent-ask-head">
        <span className="agent-ask-state"><RiQuestionLine aria-hidden />답변 대기 중</span>
        {questions.length > 1 && (
          <div className="agent-ask-steps" role="tablist" aria-label="질문">
            {questions.map((entry, index) => (
              <button key={index} type="button" role="tab" aria-selected={index === step} className="agent-ask-step"
                data-done={answerOf(entry, drafts[index] ?? emptyDraft()) ? 'true' : undefined}
                disabled={!armed} onClick={event => { if (canClick(event)) setStep(index) }}>
                {answerOf(entry, drafts[index] ?? emptyDraft()) && <RiCheckLine aria-hidden />}{entry.header || `질문 ${index + 1}`}
              </button>
            ))}
            <button type="button" role="tab" aria-selected={reviewing} className="agent-ask-step"
              disabled={!armed || !answersOf(questions, drafts)} onClick={event => { if (canClick(event)) setStep(questions.length) }}>확인</button>
          </div>
        )}
        <button type="button" className="agent-ask-terminal" disabled={!armed}
          onClick={event => { if (canClick(event)) toTerminal() }} title="Claude 의 원래 질문 화면에서 답합니다">
          <RiTerminalBoxLine aria-hidden />터미널에서 답하기
        </button>
      </div>

      {reviewing ? (
        <div className="agent-ask-review">
          <dl>
            {questions.map((entry, index) => (
              <div key={index}>
                <dt>{entry.question}</dt>
                <dd>{answerText(entry, drafts[index])}</dd>
              </div>
            ))}
          </dl>
          <div className="agent-ask-footer">
            <button type="button" className="agent-ask-nav" disabled={!armed}
              onClick={event => { if (canClick(event)) setStep(questions.length - 1) }}><RiArrowLeftLine aria-hidden />이전</button>
            <button type="button" className="agent-ask-send" disabled={!armed}
              onClick={event => { if (canClick(event)) void send(drafts) }}><RiSendPlane2Line aria-hidden />보내기</button>
          </div>
        </div>
      ) : (
        <>
          <div className="agent-ask-question">{question.question}</div>
          {question.multiSelect && <div className="agent-ask-hint">여러 개를 고를 수 있습니다</div>}
          <div className="agent-ask-body" data-preview={question.preview ? 'true' : undefined}>
          <div className="agent-ask-options" role={question.multiSelect ? 'group' : 'radiogroup'} aria-label={question.header || question.question}
            onMouseLeave={question.preview ? () => setLooked(null) : undefined}>
            {question.options.map((option, index) => {
              const on = draft.picks.includes(index)
              return (
                <button key={index} type="button" className="agent-ask-option" data-on={on ? 'true' : undefined}
                  role={question.multiSelect ? 'checkbox' : 'radio'} aria-checked={on}
                  disabled={!armed} onClick={event => { if (canClick(event)) choose(index) }}
                  onMouseEnter={question.preview ? () => setLooked(index) : undefined}
                  onFocus={question.preview ? () => setLooked(index) : undefined}>
                  <span className="agent-ask-mark" aria-hidden>{question.multiSelect ? (on ? <RiCheckLine /> : null) : index + 1}</span>
                  <span className="agent-ask-text">
                    <span className="agent-ask-label">{option.label}</span>
                    {option.description && <span className="agent-ask-description">{option.description}</span>}
                  </span>
                </button>
              )
            })}
            {/* The CLI has no "Type something" row beside previews */}
            {!question.preview && <OtherAnswer question={question} draft={draft} onChange={update} problem={problem} armed={armed} canClick={canClick} />}
          </div>
          {question.preview && (
            <pre className="agent-ask-preview" aria-label="미리보기">{shownPreview || '미리보기가 없는 선택지입니다.'}</pre>
          )}
          </div>
          {!direct && (
            <div className="agent-ask-footer">
              {step > 0 && <button type="button" className="agent-ask-nav" disabled={!armed}
                onClick={event => { if (canClick(event)) setStep(step - 1) }}><RiArrowLeftLine aria-hidden />이전</button>}
              <button type="button" className="agent-ask-send" disabled={!armed || !complete} onClick={event => { if (canClick(event)) next() }}>
                {questions.length === 1 ? <><RiSendPlane2Line aria-hidden />보내기</> : <>다음<RiArrowRightLine aria-hidden /></>}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function OtherAnswer({ question, draft, onChange, problem, armed, canClick }: {
  question: AgentAskQuestion; draft: AskDraft; onChange: (draft: AskDraft) => void; problem: string | null
  armed: boolean; canClick: (event: MouseEvent<HTMLButtonElement>) => boolean
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const focusNext = useRef(false)
  useEffect(() => {
    if (draft.otherOn && focusNext.current) {
      focusNext.current = false
      inputRef.current?.focus()
    }
  }, [draft.otherOn])
  return (
    <div className="agent-ask-other" data-on={draft.otherOn ? 'true' : undefined}>
      <button type="button" className="agent-ask-option" role={question.multiSelect ? 'checkbox' : 'radio'} aria-checked={draft.otherOn}
        data-on={draft.otherOn ? 'true' : undefined} disabled={!armed} onClick={event => {
          if (!canClick(event)) return
          focusNext.current = !draft.otherOn
          onChange(toggleOther(question, draft, !draft.otherOn))
        }}>
        <span className="agent-ask-mark" aria-hidden>{draft.otherOn ? <RiCheckLine /> : '…'}</span>
        <span className="agent-ask-text"><span className="agent-ask-label">직접 입력</span></span>
      </button>
      {draft.otherOn && (
        <>
          <input ref={inputRef} className="agent-ask-input" value={draft.other} maxLength={500} placeholder="답을 한 줄로 적어 주세요"
            aria-label="직접 입력한 답" aria-invalid={problem ? true : undefined}
            onChange={event => onChange({ ...draft, other: event.target.value })} />
          {problem && draft.other && <div className="agent-ask-problem" role="alert">{problem}</div>}
        </>
      )}
    </div>
  )
}

/** The question in the conversation: its questions, and their answers once given */
export function AskQuestionSummary({ tool }: { tool: NonNullable<AgentChatItem['tool']> }) {
  const questions = tool.question?.questions ?? []
  const waiting = tool.result === undefined && !tool.isError
  return (
    <div className="agent-chat-tool agent-ask-summary" data-error={tool.isError ? 'true' : undefined}>
      <div className="agent-chat-tool-head">
        <span className="agent-chat-tool-name"><RiQuestionLine aria-hidden />질문</span>
        <span className="agent-chat-tool-state">{waiting ? '답변 대기 중' : tool.isError ? '답하지 않았습니다' : '답함'}</span>
      </div>
      <dl>
        {questions.map((entry, index) => (
          <div key={index}>
            <dt>{entry.question}</dt>
            {/* While waiting the card below has the choices: only the questions here */}
            {!waiting && <dd>{tool.answers?.[index] ?? '—'}</dd>}
          </div>
        ))}
      </dl>
    </div>
  )
}
