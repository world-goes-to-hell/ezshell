import { useEffect, useState, type FormEvent } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { RiFolderOpenLine } from 'react-icons/ri'
import type { LocalAgent, LocalProjectInfo } from '../../types'
import { readLocalProjects, writeLocalProjects } from '../../lib/localProjectList'
import './LocalProjectDialog.css'

const CURRENT = 'current'
const NEW = 'new'
const folderName = (folder: string) => folder.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || folder

export interface LocalProjectTerminal {
  cwd: string
  workspaceLabel: string
  agent?: LocalAgent
}

interface LocalProjectDialogProps {
  /**
   * `add` (the work list's +): starts with no folder; the picked one is registered when it is opened.
   * `open` (command palette): picks one of the registered folders.
   */
  mode: 'add' | 'open'
  onClose: () => void
  onOpenTerminal: (options: LocalProjectTerminal) => Promise<boolean>
}

// The shell is the user's own (PowerShell / $SHELL). An agent is started by typing it in that shell:
// the dialog does not choose one (user decision, 2026-11-20).
export function LocalProjectDialog({ mode, onClose, onOpenTerminal }: LocalProjectDialogProps) {
  const isAdd = mode === 'add'
  const [folders, setFolders] = useState(readLocalProjects)
  const [folder, setFolder] = useState(() => (isAdd ? '' : folders[0] ?? ''))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const updateFolders = (next: string[], selected: string) => {
    setFolders(next)
    setFolder(selected)
    // The sidebar's local tree shows the same list and hears the change
    if (!writeLocalProjects(next)) setError('작업 폴더 목록을 저장하지 못했습니다.')
  }

  const pickFolder = async () => {
    setBusy(true)
    setError('')
    try {
      const result = await window.electronAPI.selectLocalFolder()
      if (!result.success) return
      // Adding: registered only when it is opened (closing the dialog adds nothing)
      if (isAdd) setFolder(result.path)
      else updateFolders([result.path, ...folders.filter(item => item !== result.path)], result.path)
    } catch {
      setError('폴더 선택 창을 열지 못했습니다.')
    } finally {
      setBusy(false)
    }
  }

  const register = () => {
    if (!isAdd || readLocalProjects().includes(folder)) return
    const next = [folder, ...readLocalProjects()]
    if (!writeLocalProjects(next)) setError('작업 폴더 목록을 저장하지 못했습니다.')
  }

  return (
    <Dialog.Root open onOpenChange={open => { if (!open && !busy) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="modal-content local-project-dialog" aria-describedby={undefined}>
          <Dialog.Title className="modal-title"><RiFolderOpenLine size={20} />{isAdd ? '로컬 작업 추가' : '로컬 작업'}</Dialog.Title>
          <div className="form-group">
            <label htmlFor="local-project-folder">작업 폴더</label>
            {isAdd ? (
              <div className="local-project-pick">
                <input id="local-project-folder" readOnly value={folder} placeholder="폴더를 골라 주세요" title={folder || undefined} />
                <button type="button" className="btn-secondary" disabled={busy} onClick={() => void pickFolder()}>폴더 선택…</button>
              </div>
            ) : (
              <>
                {folders.length > 0 && (
                  <select id="local-project-folder" value={folder} disabled={busy} onChange={event => setFolder(event.target.value)}>
                    {folders.map(item => <option key={item} value={item}>{item}</option>)}
                  </select>
                )}
                <div className="local-project-folders">
                  <button type="button" className="btn-secondary" disabled={busy} onClick={() => void pickFolder()}>폴더 추가…</button>
                  {folder && <button type="button" className="btn-secondary" disabled={busy} onClick={() => {
                    const next = folders.filter(item => item !== folder)
                    setError('')
                    updateFolders(next, next[0] ?? '')
                  }}>목록에서 제거</button>}
                </div>
              </>
            )}
          </div>
          {error && <p className="local-project-error" role="alert">{error}</p>}
          {folder ? (
            <LocalProjectForm key={folder} folder={folder} isAdd={isAdd} busy={busy} setBusy={setBusy} onClose={onClose}
              onOpenTerminal={async options => {
                const opened = await onOpenTerminal(options)
                if (opened) register()
                return opened
              }} />
          ) : (
            <div className="modal-actions"><Dialog.Close className="btn-secondary" disabled={busy}>닫기</Dialog.Close></div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function LocalProjectForm({ folder, isAdd, busy, setBusy, onClose, onOpenTerminal }: Omit<LocalProjectDialogProps, 'mode'> & {
  folder: string
  isAdd: boolean
  busy: boolean
  setBusy: (busy: boolean) => void
}) {
  const [info, setInfo] = useState<LocalProjectInfo>()
  const [notice, setNotice] = useState('')
  const [target, setTarget] = useState(CURRENT)
  const [branch, setBranch] = useState('')
  const [base, setBase] = useState('HEAD')
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    void window.electronAPI.localProjectInspect(folder).then(result => {
      if (!active) return
      if (result.success) {
        setInfo(result)
        if (result.gitMissing) setNotice('워크트리를 사용하려면 Git을 설치해 주세요.')
      } else {
        setNotice(result.error)
      }
    }).catch(() => { if (active) setNotice('폴더의 Git 정보를 읽지 못했습니다.') })
    return () => { active = false }
  }, [folder])

  const repo = info?.repo
  const otherWorktrees = repo?.worktrees.filter(tree => tree.path !== folder) ?? []
  const create = target === NEW

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    try {
      let cwd = target === CURRENT ? folder : target
      let ref = target === CURRENT ? repo?.branch : otherWorktrees.find(tree => tree.path === target)?.branch
      if (create) {
        const result = await window.electronAPI.localWorktreeCreate({ folder, branch: branch.trim(), base: base.trim() })
        if (!result.success) {
          setError(result.error)
          return
        }
        cwd = result.path
        ref = result.branch
        // A retry after a terminal failure should use the checkout Git already created.
        const tree = { path: cwd, branch: ref }
        setInfo(previous => previous?.repo ? { ...previous, repo: { ...previous.repo, worktrees: [...previous.repo.worktrees, tree] } } : previous)
        setTarget(cwd)
      }
      const workspaceLabel = ref ? `${folderName(folder)} · ${ref}` : folderName(cwd)
      if (await onOpenTerminal({ cwd, workspaceLabel })) onClose()
    } catch {
      setError(create ? '새 작업을 열지 못했습니다.' : '로컬 작업을 열지 못했습니다.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit}>
      {/* A Git repository can be opened as it is, in one of its other worktrees, or in a new worktree
          (a new branch checked out in a folder beside it): the terminal starts in that folder */}
      {repo && (
        <div className="form-group">
          <label htmlFor="local-project-target">작업할 브랜치 (Git 워크트리)</label>
          <select id="local-project-target" value={target} disabled={busy} onChange={event => { setTarget(event.target.value); setError('') }}>
            <option value={CURRENT}>이 폴더 그대로{repo.branch ? ` (${repo.branch})` : ''}</option>
            {otherWorktrees.map(tree => <option key={tree.path} value={tree.path}>{tree.branch ? `${tree.branch} · ${tree.path}` : tree.path}</option>)}
            <option value={NEW}>새 브랜치로 워크트리 만들기…</option>
          </select>
          {!create && <p className="form-hint">터미널이 열릴 폴더입니다. 다른 브랜치를 함께 작업하려면 그 브랜치의 워크트리(옆 폴더에 따로 받은 작업본)를 고르거나 새로 만드세요.</p>}
        </div>
      )}
      {create && (
        <>
          <div className="form-row">
            <div className="form-group flex-1">
              <label htmlFor="local-project-branch">새 브랜치</label>
              <input id="local-project-branch" value={branch} onChange={event => setBranch(event.target.value)} required disabled={busy} />
            </div>
            <div className="form-group flex-1">
              <label htmlFor="local-project-base">기준 브랜치 또는 커밋</label>
              <input id="local-project-base" value={base} onChange={event => setBase(event.target.value)} required disabled={busy} />
            </div>
          </div>
          <p className="form-hint">등록한 저장소의 옆 폴더에 새 워크트리를 만들고 그 폴더에서 터미널을 엽니다. 지금 폴더의 브랜치와 고치던 파일은 그대로입니다.</p>
        </>
      )}
      {notice && <p className="form-hint" role="status">{notice}</p>}
      {error && <p className="local-project-error" role="alert">{error}</p>}
      <div className="modal-actions">
        <Dialog.Close className="btn-secondary" disabled={busy}>취소</Dialog.Close>
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? '여는 중…' : create ? '만들고 열기' : isAdd ? '추가하고 열기' : '열기'}
        </button>
      </div>
    </form>
  )
}
