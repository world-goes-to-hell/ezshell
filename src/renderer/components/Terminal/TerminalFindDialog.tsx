import { useState, type FormEvent } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { RiFileSearchLine, RiSearchLine } from 'react-icons/ri'
import { buildFindCommand, parseFindPrefs, FIND_QUERY_MAX_LENGTH, type FindKind, type FindPrefs, type FindScope } from '../../lib/terminalFind'

const PREFS_KEY = 'terminalFindPrefs'

function readPrefs(): FindPrefs {
  try {
    return parseFindPrefs(localStorage.getItem(PREFS_KEY))
  } catch {
    return parseFindPrefs(null)
  }
}

function writePrefs(prefs: FindPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
  } catch {
    // Only a convenience
  }
}

const SCOPES: Array<{ value: FindScope; label: string }> = [
  { value: 'current', label: '현재 폴더부터' },
  { value: 'root', label: '루트(/)부터' },
  { value: 'custom', label: '폴더 지정' }
]

interface TerminalFindDialogProps {
  kind: FindKind
  /** Text selected in the terminal, offered as what to look for */
  initialQuery?: string
  onClose: () => void
  /** The command line to put in the shell's input line (not run) */
  onInsert: (command: string) => void
}

/**
 * "이름 찾기" / "내용 찾기": builds a find / grep command and puts it in the terminal's input line.
 * The user presses Enter: a search from a large folder reads the server's disks for a long time, so
 * the app never starts one by itself.
 */
export function TerminalFindDialog({ kind, initialQuery = '', onClose, onInsert }: TerminalFindDialogProps) {
  const [prefs, setPrefs] = useState(readPrefs)
  const [query, setQuery] = useState(initialQuery)
  const [problem, setProblem] = useState<string | null>(null)
  const isName = kind === 'name'
  const result = buildFindCommand({ kind, query, scope: prefs.scope, customDir: prefs.customDir, ignoreCase: prefs.ignoreCase })

  const change = (next: Partial<FindPrefs>): void => {
    setPrefs(current => ({ ...current, ...next }))
    setProblem(null)
  }

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (!result.ok) {
      setProblem(result.problem)
      return
    }
    writePrefs(prefs)
    onInsert(result.command)
  }

  return (
    <Dialog.Root open onOpenChange={(isOpen) => { if (!isOpen) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="modal-content terminal-find-dialog" aria-describedby="terminal-find-note">
          <Dialog.Title className="modal-title">
            {isName ? <RiFileSearchLine size={18} aria-hidden="true" /> : <RiSearchLine size={18} aria-hidden="true" />}
            {isName ? '이름으로 파일 찾기' : '내용으로 파일 찾기'}
          </Dialog.Title>
          <form onSubmit={submit}>
            <div className="form-group">
              <label htmlFor="terminal-find-query">{isName ? '파일·폴더 이름' : '찾을 내용'}</label>
              <input
                id="terminal-find-query"
                value={query}
                autoFocus
                spellCheck={false}
                autoComplete="off"
                maxLength={FIND_QUERY_MAX_LENGTH}
                placeholder={isName ? '예: nginx.conf 또는 *.log' : '예: jdbc:mysql'}
                onChange={(e) => { setQuery(e.target.value); setProblem(null) }}
              />
            </div>
            <div className="form-group">
              <label id="terminal-find-scope-label">찾을 위치</label>
              <div className="terminal-find-scope" role="radiogroup" aria-labelledby="terminal-find-scope-label">
                {SCOPES.map(scope => (
                  <label key={scope.value}>
                    <input type="radio" name="terminal-find-scope" checked={prefs.scope === scope.value} onChange={() => change({ scope: scope.value })} />
                    <span>{scope.label}</span>
                  </label>
                ))}
              </div>
              {prefs.scope === 'custom' && (
                <input
                  style={{ marginTop: 8 }}
                  value={prefs.customDir}
                  spellCheck={false}
                  autoComplete="off"
                  aria-label="찾을 폴더"
                  placeholder="예: /var/log"
                  onChange={(e) => change({ customDir: e.target.value })}
                />
              )}
              {prefs.scope === 'root' && (
                <p className="terminal-find-warning">서버 전체를 읽으므로 오래 걸리고 디스크에 부담을 줄 수 있습니다. 실행 중에는 Ctrl+C 로 멈춥니다.</p>
              )}
            </div>
            {!isName && (
              <div className="form-group checkbox-group">
                <label>
                  <input type="checkbox" checked={prefs.ignoreCase} onChange={(e) => change({ ignoreCase: e.target.checked })} />
                  <span>대소문자 구분 안 함</span>
                </label>
              </div>
            )}
            <div className="form-group">
              <label>입력될 명령</label>
              <pre className={`terminal-find-preview${result.ok ? '' : ' is-empty'}`}>{result.ok ? result.command : (isName ? '이름을 입력하면 명령이 보입니다' : '내용을 입력하면 명령이 보입니다')}</pre>
              <p id="terminal-find-note" className="terminal-find-note">
                터미널 입력줄에 채워 넣기만 합니다. 확인하거나 고친 뒤 Enter 로 직접 실행하세요.
              </p>
            </div>
            {problem && <p className="db-connect-error" role="alert">{problem}</p>}
            <div className="modal-actions">
              <button type="button" className="btn-secondary modal-btn" onClick={onClose}>취소</button>
              <button type="submit" className="btn-primary modal-btn">터미널에 입력</button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
