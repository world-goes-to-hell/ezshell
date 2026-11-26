// The question main asks before a run preset runs something the user should read first: a typed command
// the first time (needsConfirm), or the install before the server (needsInstall). Not the shared confirm
// dialog: there Enter on the first focus approved at once, whitespace folded so the text read differed
// from what runs, and a long command pushed the window off the screen (review of stage 1). What main asks
// about grew (folder, JDK, env, hot reload, Tomcat's and Maven's settings): several parts are shown as titled
// sections. main keeps only a hash of what was approved, so it says what runs, not what changed.
import { useRef } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { RiTerminalBoxLine } from 'react-icons/ri'
import { answerRunCommand, useRunPresets } from '../../stores/runPresetStore'
import { confirmSections } from '../../lib/runPresets'
import { useApprovalArming } from '../AgentChat/useApprovalArming'
import './RunPresets.css'

export function RunCommandConfirm() {
  const ask = useRunPresets(state => state.commandAsk)
  if (!ask) return null
  if (ask.kind === 'dependencies') return <RunDependenciesDialog key={ask.key} names={ask.command} />
  // Keyed by the question so the arming starts over for each one
  return <RunCommandDialog key={ask.key} kind={ask.kind} command={ask.command} />
}

function RunDependenciesDialog({ names }: { names: string }) {
  const cancel = useRef<HTMLButtonElement>(null)
  return (
    <Dialog.Root open onOpenChange={open => { if (!open) answerRunCommand(false) }}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="modal-content run-command-dialog"
          onOpenAutoFocus={event => { event.preventDefault(); cancel.current?.focus() }}>
          <Dialog.Title className="modal-title">앞 단계도 함께 띄울까요?</Dialog.Title>
          <Dialog.Description className="run-command-lead">다음 구성은 앞 단계에 있고 아직 실행되지 않았습니다.</Dialog.Description>
          <pre className="run-command-text">{names}</pre>
          <div className="modal-actions">
            <button ref={cancel} type="button" className="btn-secondary modal-btn" onClick={() => answerRunCommand(false)}>취소</button>
            <button type="button" className="btn-secondary modal-btn" onClick={() => answerRunCommand('only')}>이 구성만 실행</button>
            <button type="button" className="btn-primary modal-btn" onClick={() => answerRunCommand(true)}>앞 단계도 실행</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

const TEXTS = {
  custom: { title: '직접 입력한 명령 실행', lead: '처음 실행하는 명령입니다. 내용을 확인해 주세요.', confirm: '실행' },
  install: { title: '의존성 설치', lead: '의존성을 먼저 설치합니다.', confirm: '설치 후 실행' },
  action: { title: '작업 확인', lead: '다음 작업을 합니다. 내용을 확인해 주세요.', confirm: '확인' }
}

function RunCommandDialog({ kind, command }: { kind: 'custom' | 'install' | 'action'; command: string }) {
  const { armed, canActivate } = useApprovalArming()
  const cancel = useRef<HTMLButtonElement>(null)
  const sections = kind === 'custom' ? confirmSections(command) : null
  // Several parts: what the preset runs as a whole (a typed command alone keeps its own words)
  const text = sections
    ? { title: '실행 내용 확인', lead: '처음 실행하거나 실행 내용이 바뀌었습니다. 내용을 확인해 주세요.', confirm: '실행' }
    : TEXTS[kind]
  return (
    <Dialog.Root open onOpenChange={open => { if (!open) answerRunCommand(false) }}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="modal-content run-command-dialog" aria-describedby="run-command-text"
          onOpenAutoFocus={event => { event.preventDefault(); cancel.current?.focus() }}>
          <Dialog.Title className="modal-title">
            <RiTerminalBoxLine size={18} aria-hidden="true" />
            {text.title}
          </Dialog.Title>
          <p className="run-command-lead">{text.lead}</p>
          {/* The exact text that runs: spaces and tabs as they are, long commands scroll inside */}
          {sections ? (
            <div id="run-command-text" className="run-command-text run-command-sections">
              {sections.map((section, index) => (
                <section key={index}>
                  {section.title && <strong>{section.title}</strong>}
                  <pre>{section.body}</pre>
                  {/* Env values are only in main's hash: a changed value asks again with the same names */}
                  {section.title.includes('환경 변수') && <small className="run-command-note">값은 보이지 않습니다. 값이 바뀌어도 다시 확인합니다.</small>}
                </section>
              ))}
            </div>
          ) : (
            <pre id="run-command-text" className="run-command-text">{command}</pre>
          )}
          <div className="modal-actions">
            <button ref={cancel} type="button" className="btn-secondary modal-btn" onClick={() => answerRunCommand(false)}>취소</button>
            <button type="button" className="btn-primary modal-btn" disabled={!armed}
              onClick={() => { if (canActivate()) answerRunCommand(true) }}>
              {text.confirm}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
