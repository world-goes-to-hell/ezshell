import { useState } from 'react'
import { RiDatabase2Line } from 'react-icons/ri'
import { PopoutTitleBar } from '../TitleBar/PopoutTitleBar'
import { DbClientView, type DbViewTitle } from './DbClientView'
import { usePopoutTheme } from '../../hooks/usePopoutTheme'
import '../RemoteFile/RemoteFile.css'
import './DbClient.css'

/** A DB account in its own window (`?dbMode=true&dbId=...`), opened by "창으로 분리" on a DB tab. */
export function DbClientWindow({ dbId }: { dbId: string }) {
  usePopoutTheme()
  const [title, setTitle] = useState<DbViewTitle>({ title: 'DB', subtitle: '' })

  const showTitle = (next: DbViewTitle): void => {
    setTitle(next)
    document.title = `${next.title} - ezShell`
  }

  return (
    <div className="remote-file-window db-window">
      <PopoutTitleBar icon={<RiDatabase2Line size={16} />} title={title.title} subtitle={title.subtitle || undefined} />
      <DbClientView dbId={dbId} onTitle={showTitle} />
    </div>
  )
}
