import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react'
import { RiArrowDownSLine, RiArrowRightSLine, RiDownloadLine, RiFolderOpenLine, RiGitBranchLine,
  RiMoreLine, RiPlayLine, RiRobot2Line, RiTerminalBoxLine } from 'react-icons/ri'
import { folderLabel, pathKey } from '../../lib/localWorkspaceTree'
import { OPEN_LOCAL_TERMINAL_EVENT, readLocalProjects, writeLocalProjects } from '../../lib/localProjectList'
import type { LocalAgent, NestedRepositoryPullResult, NestedRepositoryStatus } from '../../types'
import { changedRepository, checkNestedRepositoryRemote, pullNestedRepositories, pullPending, repositoryForPreset,
  setNestedRepositoryAutoFetch, setNestedRepositoryTrust, useNestedRepositories } from '../../stores/nestedRepositoryStore'
import { toast } from '../../stores/toastStore'
import { TerminalContextMenu } from '../Terminal/TerminalContextMenu'
import { NestedRepositoryBranchDialog } from './NestedRepositoryBranchDialog'
import './NestedRepositories.css'

export function NestedRepositorySettings() {
  const enabled = useNestedRepositories(state => state.autoFetchEnabled)
  const [saving, setSaving] = useState(false)
  useEffect(() => { void setNestedRepositoryAutoFetch() }, [])
  return (
    <section className="settings-section">
      <h3 className="settings-section-title"><RiGitBranchLine size={18} /> 하위 Git 저장소</h3>
      <label className="nested-repositories-setting">
        <input type="checkbox" checked={enabled} disabled={saving} onChange={event => {
          setSaving(true)
          void setNestedRepositoryAutoFetch(event.target.checked).finally(() => setSaving(false))
        }} />
        신뢰한 로컬 작업의 자동 원격 확인 허용
      </label>
      <p className="settings-section-desc">각 로컬 작업에서 켤 수 있습니다. 창으로 돌아올 때 작업당 10분에 한 번까지 확인합니다.</p>
    </section>
  )
}

export function NestedRepositorySummary({ project }: { project: string }) {
  const summary = useNestedRepositories(state => state.summaries[pathKey(project)])
  if (!summary?.count) return null
  const branch = summary.branch ?? (summary.detached ? '분리된 HEAD' : '브랜치 여러 개')
  return <span className="nested-repository-summary">
    {summary.readable && <span className="nested-repository-branch" title={branch}><RiGitBranchLine size={11} aria-hidden="true" /><span>{branch}</span></span>}
    <span>{summary.count}개</span>
    {summary.behind > 0 && <span className="nested-repository-behind" title={`받을 커밋이 있는 저장소 ${summary.behind}개`}>↓{summary.behind}개</span>}
  </span>
}

function NestedRepositoryBranchChip({ branch }: { branch: string }) {
  const sizeRef = useRef<HTMLSpanElement>(null)
  const [compact, setCompact] = useState(false)
  const short = branch.slice(branch.lastIndexOf('/') + 1)
  useLayoutEffect(() => {
    const size = sizeRef.current
    if (!size || short === branch) return
    const fit = () => setCompact(size.scrollWidth > size.clientWidth)
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(size)
    return () => observer.disconnect()
  }, [branch, short])
  return <span className="nested-repository-chip" data-kind="branch" title={branch}>
    <span ref={sizeRef} className="nested-repository-branch-size" aria-hidden="true">{branch}</span>
    <span className="nested-repository-branch-label">{compact ? short : branch}</span>
  </span>
}

export function NestedRepositoryRunChips({ root, relative, runningSince }: { root: string; relative: string; runningSince?: number }) {
  const id = pathKey(root)
  const group = useNestedRepositories(state => state.groups[id])
  const repository = repositoryForPreset(group, relative)
  const pulling = useNestedRepositories(state => repository ? pullPending(state.progress[id]?.[repository.folder]) : false)
  const lastPulled = useNestedRepositories(state => repository ? state.lastPulled[pathKey(repository.path)] : undefined)
  const restart = runningSince !== undefined && lastPulled !== undefined && runningSince < lastPulled
  if (!repository || repository.error !== undefined) return null
  const showBranch = repository.branch !== group?.branch || !repository.branch
  if (!showBranch && !repository.behind && !repository.changed && !restart) return null
  const branch = repository.branch ?? '분리된 HEAD'
  return <span className="nested-repository-chips">
    {showBranch && <NestedRepositoryBranchChip branch={branch} />}
    {repository.behind > 0 && <button className="nested-repository-chip" type="button" data-kind="behind" disabled={pulling}
      title={`${repository.folder} 최신 커밋 받기 (${repository.behind}개)`}
      onClick={event => { event.stopPropagation(); void pullNestedRepositories(root, [repository]) }}>↓{repository.behind}</button>}
    {repository.changed > 0 && <span className="nested-repository-chip" data-kind="dirty" title={`수정 ${repository.changed}개`}>수정</span>}
    {restart && <span className="nested-repository-chip" data-kind="dirty" title="새 커밋을 반영하려면 재기동하세요.">재기동 필요</span>}
  </span>
}

function pullLabel(result: NestedRepositoryPullResult) {
  switch (result.kind) {
    case 'queued': return '대기'
    case 'running': return '받는 중'
    case 'received': return `받음 ${result.count}`
    case 'skipped': return '건너뜀'
    case 'failed': return '실패'
  }
}

export function NestedRepositoryList({ root, onOpenTerminal, onAddPreset }: {
  root: string
  onOpenTerminal: (repository: NestedRepositoryStatus) => void
  onAddPreset: (relative: string) => void
}) {
  const id = pathKey(root)
  const group = useNestedRepositories(state => state.groups[id])
  const progress = useNestedRepositories(state => state.progress[id])
  const trusted = useNestedRepositories(state => group ? !!state.trusted[pathKey(group.project)] : false)
  const autoFetchEnabled = useNestedRepositories(state => state.autoFetchEnabled)
  const [savingTrust, setSavingTrust] = useState(false)
  const [checkingRemote, setCheckingRemote] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const [menu, setMenu] = useState<{ repository: NestedRepositoryStatus; position: { x: number; y: number } } | null>(null)
  const [branchFolder, setBranchFolder] = useState<string | null>(null)
  if (!group?.repositories.length) return null
  const { repositories, branch } = group
  const active = repositories.some(repo => pullPending(progress?.[repo.folder]))
  const shown = repositories.filter(repo => showAll || changedRepository(repo, branch) || progress?.[repo.folder])

  const openMenu = (event: MouseEvent<HTMLElement>, repository: NestedRepositoryStatus) => {
    event.preventDefault()
    event.stopPropagation()
    const rect = event.clientX === 0 && event.clientY === 0 || event.currentTarget instanceof HTMLButtonElement
      ? event.currentTarget.getBoundingClientRect() : null
    setMenu({ repository, position: { x: rect?.left ?? event.clientX, y: rect?.bottom ?? event.clientY } })
  }
  const openAgent = (repository: NestedRepositoryStatus, agent: LocalAgent) => {
    window.dispatchEvent(new CustomEvent(OPEN_LOCAL_TERMINAL_EVENT, {
      detail: { cwd: repository.path, workspaceLabel: folderLabel(repository.path), agent }
    }))
  }
  const promote = (repository: NestedRepositoryStatus) => {
    const current = readLocalProjects()
    if (current.some(folder => pathKey(folder) === pathKey(repository.path))) return
    if (!writeLocalProjects([repository.path, ...current])) toast.error('로컬 작업을 추가하지 못했습니다.')
  }
  const openExplorer = async (repository: NestedRepositoryStatus) => {
    const result = await window.electronAPI.localProjectOpenFolder?.(repository.path).catch(() => undefined)
    if (!result?.success) toast.error('파일 탐색기로 열지 못했습니다', result?.error)
  }

  return (
    <section className="nested-repositories" data-nested-root={root} aria-label="하위 저장소">
      <button className="nested-repositories-toggle" type="button" aria-expanded={expanded}
        onClick={() => setExpanded(value => !value)}>
        {expanded ? <RiArrowDownSLine size={13} /> : <RiArrowRightSLine size={13} />} 저장소 {repositories.length}개
      </button>
      {expanded && <>
        <div className="nested-repositories-controls nested-repository-remote-controls">
          {group.manualOnly ? <span title="승인한 폴더 밖의 워크트리입니다.">수동 확인만</span> :
          <label className="nested-repository-trust" title={autoFetchEnabled ? undefined : '설정에서 모든 자동 원격 확인을 껐습니다.'}>
            <input type="checkbox" role="switch" checked={trusted} disabled={savingTrust} onChange={event => {
              setSavingTrust(true)
              void setNestedRepositoryTrust(group.project, event.target.checked).finally(() => setSavingTrust(false))
            }} />
            자동으로 원격 확인
          </label>}
          <button type="button" className="nested-repository-pull" disabled={checkingRemote || active}
            onClick={() => {
              setCheckingRemote(true)
              void checkNestedRepositoryRemote(group.project).finally(() => setCheckingRemote(false))
            }}>
            {checkingRemote ? '확인 중…' : '원격 확인'}
          </button>
        </div>
        <div className="nested-repositories-controls">
          <div className="nested-repository-filter" role="group" aria-label="저장소 필터">
            <button type="button" aria-pressed={!showAll} onClick={() => setShowAll(false)}>다른 것</button>
            <button type="button" aria-pressed={showAll} onClick={() => setShowAll(true)}>전체</button>
          </div>
          <button type="button" className="nested-repository-pull" disabled={active}
            onClick={() => void pullNestedRepositories(root, repositories)}><RiDownloadLine size={12} /> 모두 최신으로</button>
        </div>
        {shown.length > 0 ? <ul className="nested-repository-list">
          {shown.map(repo => {
            const result = progress?.[repo.folder]
            const state = repo.error === undefined ? repo : null
            return <li key={repo.folder} className="nested-repository-row" data-nested-repo={repo.folder}
              onContextMenu={event => openMenu(event, repo)}>
              <div className="nested-repository-main">
                <button type="button" className="nested-repository-open" aria-label={`${repo.folder}에서 터미널 열기`}
                  title={repo.path} onClick={() => onOpenTerminal(repo)}>
                  <RiGitBranchLine size={13} aria-hidden="true" />
                  <span className="nested-repository-name">{repo.folder}</span>
                </button>
                {state && <button type="button" className="nested-repository-ref" data-different={state.branch !== branch || undefined}
                  aria-label={`${repo.folder} 브랜치 바꾸기`} title={`${state.branch ?? '분리된 HEAD'} · 브랜치 바꾸기`}
                  onClick={() => setBranchFolder(repo.folder)}>
                  {state.branch ?? '분리된 HEAD'}
                </button>}
              </div>
              <span className="nested-repository-changes">
                {!!state?.ahead && <span title="로컬이 앞선 커밋">↑{state.ahead}</span>}
                {!!state?.behind && <span className="nested-repository-behind" title="받을 커밋">↓{state.behind}</span>}
                {!!state?.changed && <span className="nested-repository-dirty" title="수정한 파일">수정 {state.changed}</span>}
              </span>
              <button type="button" className="nested-repository-more" aria-label={`${repo.folder} 메뉴`}
                onClick={event => openMenu(event, repo)}><RiMoreLine size={14} /></button>
              {result && <span className="nested-repository-result" data-result={result.kind} role="status">
                {pullLabel(result)}{'message' in result && ` · ${result.message}`}
              </span>}
              {!result && repo.error && <span className="nested-repository-result" data-result="failed">{repo.error}</span>}
              {!result && state?.fetchError && <span className="nested-repository-result" data-result="failed">가져오기 실패 · {state.fetchError}</span>}
              {!result && state?.upstreamGone && <span className="nested-repository-result" data-result="skipped">원격 브랜치가 지워졌습니다.</span>}
            </li>
          })}
        </ul> : <p className="nested-repository-empty">다른 저장소가 없습니다.</p>}
      </>}
      {menu && <TerminalContextMenu position={menu.position} onClose={() => setMenu(null)} top={[]}
        groups={[{ label: '에이전트 열기', icon: RiRobot2Line, items: [
          { label: 'Claude Code', icon: RiRobot2Line, onSelect: () => openAgent(menu.repository, 'claude') },
          { label: 'Codex', icon: RiRobot2Line, onSelect: () => openAgent(menu.repository, 'codex') }
        ] }]}
        target={{ name: menu.repository.folder, hint: '하위 저장소', items: [
          { label: '최신으로 받기', icon: RiDownloadLine, disabled: pullPending(progress?.[menu.repository.folder]),
            onSelect: () => void pullNestedRepositories(root, [menu.repository]) },
          { label: '브랜치 바꾸기…', icon: RiGitBranchLine, onSelect: () => setBranchFolder(menu.repository.folder) },
          { label: '기동 설정…', icon: RiPlayLine, onSelect: () => onAddPreset(menu.repository.folder) },
          { label: '로컬 터미널 열기', icon: RiTerminalBoxLine, onSelect: () => onOpenTerminal(menu.repository) },
          { label: '파일 탐색기로 열기', icon: RiFolderOpenLine, onSelect: () => void openExplorer(menu.repository) },
          { label: '따로 로컬 작업으로 올리기', icon: RiFolderOpenLine, onSelect: () => promote(menu.repository) }
        ] }} />}
      {branchFolder && <NestedRepositoryBranchDialog project={group.project} root={root} folder={branchFolder}
        onClose={() => setBranchFolder(null)} />}
    </section>
  )
}
