import { useCallback, useEffect, useState } from 'react'
import { RiErrorWarningLine, RiFileLine, RiLoader4Line } from 'react-icons/ri'
import { PopoutTitleBar } from '../TitleBar/PopoutTitleBar'
import { RemoteTextEditView } from './RemoteTextEditView'
import { RemotePreviewView } from './RemotePreviewView'
import { usePopoutTheme } from '../../hooks/usePopoutTheme'
import { fileNameOf } from '../../lib/remoteFileText'
import type { RemoteFileLoaded } from '../../types'
import './RemoteFile.css'

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; file: RemoteFileLoaded; version: number }

/** A server file in its own window (`?remoteFileMode=true&docId=...`): editing or preview. */
export function RemoteFileWindow({ docId }: { docId: string }) {
  usePopoutTheme()
  const [state, setState] = useState<LoadState>({ status: 'loading' })

  const load = useCallback(async () => {
    setState(previous => (previous.status === 'ready' ? previous : { status: 'loading' }))
    const result = await window.electronAPI.remoteFileLoad?.(docId)
    if (!result) {
      setState({ status: 'error', message: '앱을 다시 시작한 뒤에 사용할 수 있습니다.' })
      return
    }
    if (!result.success) {
      setState({ status: 'error', message: result.error })
      return
    }
    setState(previous => ({ status: 'ready', file: result, version: previous.status === 'ready' ? previous.version + 1 : 0 }))
  }, [docId])

  useEffect(() => { void load() }, [load])

  useEffect(() => {
    if (state.status === 'ready') document.title = `${fileNameOf(state.file.path)} - ezShell`
  }, [state])

  if (state.status !== 'ready') {
    return (
      <div className="remote-file-window">
        <PopoutTitleBar icon={<RiFileLine size={16} />} title="서버 파일" />
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
    return <RemoteTextEditView docId={docId} file={file} />
  }
  return <RemotePreviewView key={version} docId={docId} file={file} onRefresh={() => void load()} />
}
