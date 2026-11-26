// The run presets head's start / stop with run bundles (docs/plan/2026-11-26-multi-repo-and-start-order.md part 3,
// mockup scene 6): where 모두 실행 was. The button starts or stops the chosen bundle (or all); its arrow opens the
// bundles with their sizes, 전체, and 묶음 만들기…. A bundle only picks presets: main runs them in the
// project's start order and skips the others. Without bundles it is the old 모두 실행 / 모두 중지.
import { useEffect, useState } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { RiAddLine, RiArrowDownSLine, RiCheckLine, RiDeleteBinLine, RiEditLine, RiPlayFill, RiStopFill } from 'react-icons/ri'
import { bundleHead, bundleMembers, readBundleChoice, writeBundleChoice, type RunBundle } from '../../lib/runBundles'
import { reloadProjectPresets, runPresetAction, type WorktreeRuns } from '../../stores/runPresetStore'
import { confirmDialog } from '../../stores/confirmStore'
import { toast } from '../../stores/toastStore'
import { RunBundleDialog } from './RunBundleDialog'
import './RunBundles.css'

export function RunBundlePicker({ folder, runs }: {
  /** The worktree the card is for (its runs) */
  folder: string
  runs: WorktreeRuns
}) {
  const { presets, states, bundles, projectKey } = runs
  const [chosen, setChosen] = useState<RunBundle | null>(() => readBundleChoice(projectKey, bundles))
  // The chosen bundle follows the saved ones (renamed, changed, deleted elsewhere)
  useEffect(() => {
    setChosen(current => current ? bundles.find(bundle => bundle.id === current.id) ?? null : readBundleChoice(projectKey, bundles))
  }, [bundles, projectKey])
  const [editing, setEditing] = useState<RunBundle | 'new' | null>(null)
  const canSave = typeof window.electronAPI.runPresetBundleSave === 'function'

  const choose = (bundle: RunBundle | null) => {
    setChosen(bundle)
    writeBundleChoice(projectKey, bundle)
  }
  const head = bundleHead(presets, states, chosen, runs.startOrder)
  const count = (bundle: RunBundle | null) => bundleMembers(presets, bundle, runs.startOrder).length
  const go = () => void runPresetAction(folder, head.action === 'stop' ? 'stopAll' : 'startAll', undefined, chosen ? { bundleId: chosen.id } : undefined)
  const remove = async (bundle: RunBundle) => {
    const yes = await confirmDialog({ title: '묶음 삭제', message: `‘${bundle.name}’ 묶음을 지웁니다. 실행 구성은 그대로 남습니다.`, confirmLabel: '삭제', danger: true })
    if (!yes) return
    const result = await window.electronAPI.runPresetBundleDelete?.(folder, bundle.id).catch(() => undefined)
    if (!result || result.ok === false) { toast.error('묶음을 지우지 못했습니다', result?.error); return }
    if (chosen?.id === bundle.id) choose(null)
    void reloadProjectPresets(folder)
  }

  return (
    <div className="run-bundle-picker" data-bundle={chosen?.id}>
      <button type="button" className="run-bundle-go" data-action={head.action} disabled={head.action === 'start' && !head.canStart}
        onClick={go} title={head.title}>
        {head.action === 'stop' ? <RiStopFill size={11} aria-hidden="true" /> : <RiPlayFill size={11} aria-hidden="true" />}
        <span className="run-bundle-go-label">{head.label}</span>
      </button>
      <DropdownMenu.Root modal={false}>
        <DropdownMenu.Trigger asChild>
          <button type="button" className="run-bundle-more" aria-label="실행 묶음 고르기" title="실행 묶음 고르기">
            <RiArrowDownSLine size={13} aria-hidden="true" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className="terminal-menu sidebar-popover run-bundle-menu" side="bottom" align="end" sideOffset={4} collisionPadding={8}>
            {bundles.map(bundle => (
              <DropdownMenu.Item key={bundle.id} className="terminal-menu-item run-bundle-item" data-on={chosen?.id === bundle.id || undefined}
                onSelect={() => choose(bundle)}>
                {chosen?.id === bundle.id ? <RiCheckLine size={15} aria-hidden="true" /> : <span className="run-bundle-check" aria-hidden="true" />}
                <span className="run-bundle-name">{bundle.name}</span>
                <span className="run-bundle-count">{count(bundle)}개</span>
              </DropdownMenu.Item>
            ))}
            <DropdownMenu.Item className="terminal-menu-item run-bundle-item" data-on={!chosen || undefined} onSelect={() => choose(null)}>
              {!chosen ? <RiCheckLine size={15} aria-hidden="true" /> : <span className="run-bundle-check" aria-hidden="true" />}
              <span className="run-bundle-name">전체</span>
              <span className="run-bundle-count">{count(null)}개</span>
            </DropdownMenu.Item>
            {canSave && (<>
              <DropdownMenu.Separator className="terminal-menu-separator" />
              <DropdownMenu.Item className="terminal-menu-item" onSelect={() => setEditing('new')}>
                <RiAddLine size={15} aria-hidden="true" /> 묶음 만들기…
              </DropdownMenu.Item>
              {chosen && (<>
                <DropdownMenu.Item className="terminal-menu-item" onSelect={() => setEditing(chosen)}>
                  <RiEditLine size={15} aria-hidden="true" /> ‘{chosen.name}’ 수정…
                </DropdownMenu.Item>
                <DropdownMenu.Item className="terminal-menu-item run-presets-danger" onSelect={() => void remove(chosen)}>
                  <RiDeleteBinLine size={15} aria-hidden="true" /> ‘{chosen.name}’ 삭제
                </DropdownMenu.Item>
              </>)}
            </>)}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      {editing && (
        <RunBundleDialog folder={folder} runs={runs} bundle={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)} onSaved={saved => { choose(saved); setEditing(null) }} />
      )}
    </div>
  )
}
