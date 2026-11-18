import { useEffect, useState, type FormEvent } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { RiFolderOpenLine } from 'react-icons/ri'
import type { LocalAgent, LocalProjectInfo } from '../../types'
import './LocalProjectDialog.css'

const STORAGE_KEY = 'ezshell.localProjects'
const CURRENT = 'current'
const NEW = 'new'
const folderName = (folder: string) => folder.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || folder

function readFolders(): string[] {
  try {
    const data: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
    return Array.isArray(data) ? [...new Set(data.filter((folder): folder is string => typeof folder === 'string' && folder.length > 0))] : []
  } catch {
    return []
  }
}

export interface LocalProjectTerminal {
  cwd: string
  workspaceLabel: string
  agent?: LocalAgent
}

interface LocalProjectDialogProps {
  onClose: () => void
  onOpenTerminal: (options: LocalProjectTerminal) => Promise<boolean>
}

export function LocalProjectDialog({ onClose, onOpenTerminal }: LocalProjectDialogProps) {
  const [folders, setFolders] = useState(readFolders)
  const [folder, setFolder] = useState(() => folders[0] ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const updateFolders = (next: string[], selected: string) => {
    setFolders(next)
    setFolder(selected)
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    } catch {
      setError('작업 폴더 목록을 저장하지 못했습니다.')
    }
  }

  const pickFolder = async () => {
    setBusy(true)
    setError('')
    try {
      const result = await window.electronAPI.selectLocalFolder()
      if (result.success) updateFolders([result.path, ...folders.filter(item => item !== result.path)], result.path)
    } catch {
      setError('폴더 선택 창을 열지 못했습니다.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog.Root open onOpenChange={open => { if (!open && !busy) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="modal-content local-project-dialog" aria-describedby={undefined}>
          <Dialog.Title className="modal-title"><RiFolderOpenLine size={20} />로컬 작업</Dialog.Title>
          <div className="form-group">
            {folders.length > 0 && (
              <>
                <label htmlFor="local-project-folder">작업 폴더</label>
                <select id="local-project-folder" value={folder} disabled={busy} onChange={event => setFolder(event.target.value)}>
                  {folders.map(item => <option key={item} value={item}>{item}</option>)}
                </select>
              </>
            )}
            <div className="local-project-folders">
              <button type="button" className="btn-secondary" disabled={busy} onClick={() => void pickFolder()}>폴더 추가…</button>
              {folder && <button type="button" className="btn-secondary" disabled={busy} onClick={() => {
                const next = folders.filter(item => item !== folder)
                setError('')
                updateFolders(next, next[0] ?? '')
              }}>목록에서 제거</button>}
            </div>
          </div>
          {error && <p className="local-project-error" role="alert">{error}</p>}
          {folder ? (
            <LocalProjectForm key={folder} folder={folder} busy={busy} setBusy={setBusy} onClose={onClose} onOpenTerminal={onOpenTerminal} />
          ) : (
            <div className="modal-actions"><Dialog.Close className="btn-secondary" disabled={busy}>닫기</Dialog.Close></div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function LocalProjectForm({ folder, busy, setBusy, onClose, onOpenTerminal }: LocalProjectDialogProps & {
  folder: string
  busy: boolean
  setBusy: (busy: boolean) => void
}) {
  const [info, setInfo] = useState<LocalProjectInfo>()
  const [notice, setNotice] = useState('')
  const [target, setTarget] = useState(CURRENT)
  const [agent, setAgent] = useState<LocalAgent | ''>('')
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
      if (await onOpenTerminal({ cwd, workspaceLabel, agent: agent || undefined })) onClose()
    } catch {
      setError(create ? '새 작업을 열지 못했습니다.' : '로컬 작업을 열지 못했습니다.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit}>
      {repo && (
        <div className="form-group">
          <label htmlFor="local-project-target">열 위치</label>
          <select id="local-project-target" value={target} disabled={busy} onChange={event => { setTarget(event.target.value); setError('') }}>
            <option value={CURRENT}>현재 폴더{repo.branch ? ` (${repo.branch})` : ''}</option>
            {otherWorktrees.map(tree => <option key={tree.path} value={tree.path}>{tree.branch ? `${tree.branch} · ${tree.path}` : tree.path}</option>)}
            <option value={NEW}>새 워크트리 만들기</option>
          </select>
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
          <p className="form-hint">등록한 저장소의 옆 폴더에 새 워크트리를 만듭니다.</p>
        </>
      )}
      {notice && <p className="form-hint" role="status">{notice}</p>}
      <div className="form-group">
        <label htmlFor="local-project-agent">실행 도구</label>
        <select id="local-project-agent" value={agent} disabled={busy} onChange={event => setAgent(event.target.value as LocalAgent | '')}>
          <option value="">일반 셸</option>
          <option value="codex">Codex</option>
          <option value="claude">Claude Code</option>
        </select>
        <p className="form-hint">{agent ? '이 에이전트에 메시지 MCP를 연결합니다.' : '메시지 MCP를 연결하려면 Codex 또는 Claude Code를 선택하세요.'}</p>
      </div>
      {error && <p className="local-project-error" role="alert">{error}</p>}
      <div className="modal-actions">
        <Dialog.Close className="btn-secondary" disabled={busy}>취소</Dialog.Close>
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? '여는 중…' : create ? '만들고 열기' : '열기'}
        </button>
      </div>
    </form>
  )
}
