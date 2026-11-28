import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { RiGitBranchLine } from 'react-icons/ri'
import type { NestedCheckoutMode, NestedCheckoutResult, NestedRepositoryBranch } from '../../types'
import { switchNestedRepositoryBranch } from '../../stores/nestedRepositoryStore'
import { NestedCheckoutNotice, NestedCheckoutProblem } from './NestedCheckoutProblem'

const branchKey = ({ name, remote }: NestedRepositoryBranch) => `${remote ?? ''}:\0${name}`

export function NestedRepositoryBranchDialog({ project, root, folder, onClose }: {
  project: string
  root: string
  folder: string
  onClose: () => void
}) {
  const [branches, setBranches] = useState<NestedRepositoryBranch[] | null>(null)
  const [query, setQuery] = useState('')
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  // Git refused over local edits: offer smart / force checkout. After one, say what needs attention.
  const [problem, setProblem] = useState<{ branch: NestedRepositoryBranch; files: string[] } | null>(null)
  const [notice, setNotice] = useState<{ branch: string; result: NestedCheckoutResult } | null>(null)
  const running = useRef(false)
  const listId = useId()

  useEffect(() => {
    let active = true
    async function load() {
      const result = await window.electronAPI.localNestedRepositoryBranches?.({ project, root, folder }).catch(() => undefined)
      if (!active) return
      if (result?.success) {
        setBranches([...result.branches].sort((first, second) => Number(second.current) - Number(first.current)))
      } else {
        setBranches([])
        setError(result?.error ?? '브랜치 목록을 읽지 못했습니다.')
      }
    }
    void load()
    return () => { active = false }
  }, [project, root, folder])

  const term = query.trim().toLowerCase()
  const visible = branches?.filter(branch => `${branch.remote ?? ''}/${branch.name}`.toLowerCase().includes(term)) ?? []
  const selected = visible.find(branch => branchKey(branch) === selectedKey) ?? visible[0]
  async function apply(branch?: NestedRepositoryBranch, mode?: NestedCheckoutMode) {
    if (!branch || branch.current || running.current) return
    running.current = true
    setSaving(true)
    setError('')
    try {
      const outcome = await switchNestedRepositoryBranch(root, folder, branch, mode)
      if ('localChanges' in outcome) {
        setProblem({ branch, files: outcome.localChanges })
        return
      }
      const checkout = outcome.checkout
      if (checkout && (checkout.kind === 'force' ? checkout.stash : checkout.conflicts.length)) {
        setProblem(null)
        setNotice({ branch: branch.name, result: checkout })
        return
      }
      onClose()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '브랜치를 바꾸지 못했습니다.')
    } finally {
      running.current = false
      setSaving(false)
    }
  }

  function moveSelection(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    if (!selected) return
    const offset = event.key === 'ArrowDown' ? 1 : -1
    const index = Math.max(0, Math.min(visible.length - 1, visible.indexOf(selected) + offset))
    setSelectedKey(branchKey(visible[index]))
    document.getElementById(`${listId}-${index}`)?.scrollIntoView({ block: 'nearest' })
  }

  return (
    <Dialog.Root open onOpenChange={open => { if (!open && !saving) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="modal-content nested-branch-dialog">
          <Dialog.Title className="modal-title"><RiGitBranchLine size={18} aria-hidden="true" /> {problem ? '체크아웃 문제' : '브랜치 바꾸기'}</Dialog.Title>
          <Dialog.Description className="nested-branch-folder">{folder}</Dialog.Description>
          {notice && <NestedCheckoutNotice branch={notice.branch} result={notice.result} onClose={onClose} />}
          {problem && !notice && <>
            <NestedCheckoutProblem branch={problem.branch.name} files={problem.files} busy={saving}
              onChoose={mode => void apply(problem.branch, mode)} onCancel={() => { setProblem(null); setError('') }} />
            {error && <p className="nested-branch-error" role="alert">{error}</p>}
          </>}
          {!problem && !notice && <form onSubmit={event => { event.preventDefault(); void apply(selected) }}>
            <div className="form-group nested-branch-filter">
              <input type="search" aria-label="브랜치 검색" placeholder="이름으로 거르기" value={query} disabled={saving}
                onChange={event => { setQuery(event.target.value); setSelectedKey(null) }} onKeyDown={moveSelection} />
            </div>
            {!branches && <p className="nested-branch-message" role="status">브랜치를 읽는 중…</p>}
            {branches && visible.length === 0 && !error && <p className="nested-branch-message">일치하는 브랜치가 없습니다.</p>}
            {visible.length > 0 && <ul className="nested-branch-list" aria-label="브랜치">
              {visible.map((branch, index) => (
                <li key={branchKey(branch)}>
                  <button id={`${listId}-${index}`} type="button" className="nested-branch-choice" data-branch={branch.name}
                    aria-pressed={branch === selected} disabled={saving} onClick={() => setSelectedKey(branchKey(branch))}
                    onDoubleClick={() => void apply(branch)}
                    onKeyDown={event => {
                      if (event.key === 'Enter') { event.preventDefault(); void apply(branch) }
                    }}>
                    <span className="nested-branch-name" title={branch.name}>{branch.name}</span>
                    {branch.current && <span className="nested-branch-badge">현재</span>}
                    {branch.remote && <><span className="nested-branch-remote" title={branch.remote}>{branch.remote}</span>
                      <span className="nested-branch-badge">원격</span></>}
                  </button>
                </li>
              ))}
            </ul>}
            {error && <p className="nested-branch-error" role="alert">{error}</p>}
            <div className="modal-actions">
              <Dialog.Close type="button" className="btn-secondary modal-btn" disabled={saving}>취소</Dialog.Close>
              <button type="submit" className="btn-primary modal-btn" disabled={!selected || selected.current || saving}>
                {saving ? '바꾸는 중…' : '바꾸기'}
              </button>
            </div>
          </form>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
