import { useEffect, useMemo, useState } from 'react'
import { RiEyeLine, RiRefreshLine } from 'react-icons/ri'
import { PopoutTitleBar } from '../TitleBar/PopoutTitleBar'
import { RemoteLogView } from './RemoteLogView'
import type { RemoteFileLoaded } from '../../types'
import { formatBytes } from '../../lib/mcpLabels'
import { fileNameOf } from '../../lib/remoteFileText'

type PreviewFile = Exclude<RemoteFileLoaded, { editable: true }>

interface RemotePreviewViewProps {
  docId: string
  file: PreviewFile
  onRefresh: () => void
}

function MediaPreview({ file }: { file: Extract<PreviewFile, { kind: 'image' | 'pdf' }> }) {
  const url = useMemo(() => URL.createObjectURL(new Blob([file.data], { type: file.mime })), [file])
  const [isActualSize, setIsActualSize] = useState(false)
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null)
  useEffect(() => () => URL.revokeObjectURL(url), [url])

  if (file.kind === 'pdf') {
    return <iframe className="remote-file-pdf" src={url} title={fileNameOf(file.path)} />
  }
  return (
    <div className={`remote-file-image-stage${isActualSize ? ' is-actual' : ''}`}>
      <img
        src={url}
        alt={fileNameOf(file.path)}
        className="remote-file-image"
        onClick={() => setIsActualSize(actual => !actual)}
        onLoad={(event) => setDimensions({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
        title={isActualSize ? '창에 맞추기' : '원래 크기로 보기'}
      />
      {dimensions && <span className="remote-file-image-info">{dimensions.width} × {dimensions.height} · {formatBytes(file.size)}</span>}
    </div>
  )
}

/** Looking at a server file: image, PDF, or text (a log can be followed). Nothing here writes to the server. */
export function RemotePreviewView({ docId, file, onRefresh }: RemotePreviewViewProps) {
  if (file.kind === 'text') return <RemoteLogView docId={docId} file={file} onRefresh={onRefresh} />
  const name = fileNameOf(file.path)
  const actions = (
    <button type="button" className="title-bar-btn popout-title-action" onClick={onRefresh} title="새로고침" aria-label="새로고침">
      <RiRefreshLine size={16} />
    </button>
  )

  return (
    <div className="remote-file-window">
      <PopoutTitleBar icon={<RiEyeLine size={16} />} title={name} subtitle={`${file.sessionName} · ${file.path}`} actions={actions} />
      <div className="remote-file-body">
        <MediaPreview file={file} />
      </div>
      <div className="remote-file-status">
        <span>미리보기 (읽기 전용)</span>
        <span className="remote-file-status-spacer" />
        <span>{formatBytes(file.size)}</span>
      </div>
    </div>
  )
}
