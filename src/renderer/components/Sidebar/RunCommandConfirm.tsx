// The question main asks before a run preset runs something the user should read first: a typed command
// the first time (needsConfirm), or the install before the server (needsInstall). Not the shared confirm
// dialog: there Enter on the first focus approved at once, whitespace folded so the text read differed
// from what runs, and a long command pushed the window off the screen (review of stage 1).
import { useRef } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { RiTerminalBoxLine } from 'react-icons/ri'
import { answerRunCommand, useRunPresets } from '../../stores/runPresetStore'
import { useApprovalArming } from '../AgentChat/useApprovalArming'
import './RunPresets.css'

export function RunCommandConfirm() {
  const ask = useRunPresets(state => state.commandAsk)
  if (!ask) return null
  // Keyed by the question so the arming starts over for each one
  return <RunCommandDialog key={ask.key} kind={ask.kind} command={ask.command} />
}

function RunCommandDialog({ kind, command }: { kind: 'custom' | 'install'; command: string }) {
  const { armed, canActivate } = useApprovalArming()
  const cancel = useRef<HTMLButtonElement>(null)
  const custom = kind === 'custom'
  return (
    <Dialog.Root open onOpenChange={open => { if (!open) answerRunCommand(false) }}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="modal-content run-command-dialog" aria-describedby="run-command-text"
          onOpenAutoFocus={event => { event.preventDefault(); cancel.current?.focus() }}>
          <Dialog.Title className="modal-title">
            <RiTerminalBoxLine size={18} aria-hidden="true" />
            {custom ? '직접 입력한 명령 실행' : '의존성 설치'}
          </Dialog.Title>
          <p className="run-command-lead">{custom ? '처음 실행하는 명령입니다. 내용을 확인해 주세요.' : '의존성을 먼저 설치합니다.'}</p>
          {/* The exact text that runs: spaces and tabs as they are, long commands scroll inside */}
          <pre id="run-command-text" className="run-command-text">{command}</pre>
          <div className="modal-actions">
            <button ref={cancel} type="button" className="btn-secondary modal-btn" onClick={() => answerRunCommand(false)}>취소</button>
            <button type="button" className="btn-primary modal-btn" disabled={!armed}
              onClick={() => { if (canActivate()) answerRunCommand(true) }}>
              {custom ? '실행' : '설치 후 실행'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
