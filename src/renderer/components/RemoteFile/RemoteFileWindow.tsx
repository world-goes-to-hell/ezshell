import { useCallback, useEffect, useRef, useState, type Ref } from 'react'
import { createPortal } from 'react-dom'
import { RiErrorWarningLine, RiFileLine, RiLoader4Line } from 'react-icons/ri'
import { PopoutTitleBar } from '../TitleBar/PopoutTitleBar'
import { RemoteTextEditView, type RemoteTextEditHandle } from './RemoteTextEditView'
import { RemotePreviewView } from './RemotePreviewView'
import { RemoteFileTabs } from './RemoteFileTabs'
import { usePopoutTheme } from '../../hooks/usePopoutTheme'
import { fileNameOf } from '../../lib/remoteFileText'
import { confirmDialog } from '../../stores/confirmStore'
import { toast } from '../../stores/toastStore'
import type { RemoteFileLoaded, RemoteFileTab, RemoteFileWindowState } from '../../types'
import './RemoteFile.css'

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; file: RemoteFileLoaded; version: number }

const confirmDiscard = (message: string) => confirmDialog({
  title: '저장하지 않은 변경', message, confirmLabel: '저장하지 않고 닫기', danger: true
})

interface FileDocumentProps {
  tab: RemoteFileTab
  active: boolean
  header: HTMLElement | null
  editor: Ref<RemoteTextEditHandle>
}

function FileDocument({ tab, active, header, editor }: FileDocumentProps) {
  const { docId } = tab
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const request = useRef(0)

  const load = useCallback(async () => {
    const sequence = ++request.current
    const result = await window.electronAPI.remoteFileLoad?.(docId).catch(() => null)
    if (sequence !== request.current) return
    if (!result?.success) {
      setState({ status: 'error', message: result?.error ?? '파일을 읽지 못했습니다.' })
      return
    }
    setState(previous => ({ status: 'ready', file: result, version: previous.status === 'ready' ? previous.version + 1 : 0 }))
  }, [docId])

  useEffect(() => {
    void load()
    return () => { request.current++ }
  }, [load])

  if (state.status !== 'ready') {
    return (
      <div className="remote-file-window">
        {active && header && createPortal(<PopoutTitleBar icon={<RiFileLine size={16} />} title={fileNameOf(tab.path, tab.local)} />, header)}
        <div className="remote-file-message" role={state.status === 'error' ? 'alert' : 'status'}>
          {state.status === 'loading'
            ? <><RiLoader4Line className="spinning" size={22} aria-hidden="true" /><span>파일을 읽는 중…</span></>
            : <><RiErrorWarningLine size={22} className="remote-file-message-icon" aria-hidden="true" /><span>{state.message}</span></>}
        </div>
      </div>
    )
  }

  const { file, version } = state
  if (file.kind === 'text' && file.editable) {
    return <RemoteTextEditView docId={docId} file={file} active={active} header={header} hint={tab.hint} ref={editor} />
  }
  return <RemotePreviewView key={version} docId={docId} file={file} onRefresh={() => void load()} />
}

/** A shared editor or an independent file preview, log or editor detached from the tab bar. */
export function RemoteFileWindow() {
  usePopoutTheme()
  const api = window.electronAPI
  const [state, setState] = useState<RemoteFileWindowState | null>(null)
  const [header, setHeader] = useState<HTMLDivElement | null>(null)
  const editors = useRef(new Map<string, RemoteTextEditHandle>())
  const [movingId, setMovingId] = useState<string | null>(null)
  const confirming = useRef(false)

  useEffect(() => {
    let alive = true
    const accept = (next: RemoteFileWindowState) => {
      if (alive) setState(current => current && current.revision >= next.revision ? current : next)
    }
    const unsubscribe = api.onRemoteFileWindowChanged?.(accept)
    void api.remoteFileWindowState?.().then(result => { if (result.success) accept(result) })
    return () => { alive = false; unsubscribe?.() }
  }, [api])

  useEffect(() => api.onRemoteFileCloseRequested?.(docIds => {
    if (confirming.current) return
    confirming.current = true
    void confirmDiscard(`저장하지 않은 파일이 ${docIds.length}개 있습니다. 저장하지 않고 창을 닫을까요?`).then(confirmed => {
      confirming.current = false
      if (confirmed) void api.remoteFileCloseWindow?.(docIds)
    })
  }), [api])

  const selected = state?.tabs.find(tab => tab.docId === state.activeId)
  useEffect(() => {
    if (selected) document.title = `${fileNameOf(selected.path, selected.local)} - ezShell`
  }, [selected])

  const closeTab = async (tab: RemoteFileTab) => {
    const result = await api.remoteFileClose?.(tab.docId)
    if (!result?.success || !result.needsConfirmation) return
    if (await confirmDiscard(`'${fileNameOf(tab.path, tab.local)}'의 변경을 저장하지 않고 탭을 닫을까요?`)) {
      await api.remoteFileClose?.(tab.docId, true)
    }
  }

  const detachTab = async (docId: string) => {
    if (movingId) return
    const draft = editors.current.get(docId)?.snapshot()
    if (!draft) {
      toast.info('파일이 준비된 뒤 다시 시도해 주세요.')
      return
    }
    setMovingId(docId)
    try {
      const result = await api.remoteFileDetach?.(docId, draft)
      if (!result?.success) toast.error('탭을 새 창으로 옮기지 못했습니다', result?.error)
    } catch {
      toast.error('탭을 새 창으로 옮기지 못했습니다')
    } finally {
      setMovingId(null)
    }
  }

  return (
    <div className="remote-file-stack">
      <div className="remote-file-header" ref={setHeader} inert={movingId !== null && movingId === selected?.docId}>
        {!selected && <PopoutTitleBar icon={<RiFileLine size={16} />} title="파일 편집기" />}
      </div>
      {state?.tabbed && (
        <RemoteFileTabs tabs={state.tabs} activeId={state.activeId} movingId={movingId}
          onSelect={docId => void api.remoteFileActivate?.(docId)}
          onClose={tab => void closeTab(tab)} onDetach={docId => void detachTab(docId)} />
      )}
      <div className="remote-file-panels">
        {state?.tabs.map(tab => {
          const active = tab.docId === state.activeId
          return (
            <div key={tab.docId} id={`file-pane-${tab.docId}`} className="remote-file-pane" hidden={!active}
              inert={!active || tab.docId === movingId} role={state.tabbed ? 'tabpanel' : undefined}
              aria-labelledby={state.tabbed ? `file-tab-${tab.docId}` : undefined}>
              <FileDocument tab={tab} active={active} header={header} editor={handle => {
                if (handle) editors.current.set(tab.docId, handle)
                else editors.current.delete(tab.docId)
              }} />
            </div>
          )
        })}
      </div>
    </div>
  )
}
