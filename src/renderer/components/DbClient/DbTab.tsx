import { useTerminalStore } from '../../stores/terminalStore'
import { toast } from '../../stores/toastStore'
import { DbClientView } from './DbClientView'

interface DbTabProps {
  terminalId: string
  dbId: string
  /** The saved account's name, kept after the database part of the title changes */
  label?: string
}

/** A DB connection shown as a tab of the main window (loaded only when such a tab exists). */
export function DbTab({ terminalId, dbId, label }: DbTabProps) {
  const updateTerminalTitle = useTerminalStore(state => state.updateTerminalTitle)
  const removeTerminal = useTerminalStore(state => state.removeTerminal)

  const detach = async (): Promise<void> => {
    const result = await window.electronAPI.dbDetach?.(dbId)
    if (!result?.success) {
      toast.error('창으로 분리하지 못했습니다', result && !result.success ? result.error : '앱을 다시 시작해 주세요.')
      return
    }
    // The connection now belongs to the new window; the tab only goes away
    removeTerminal(terminalId)
  }

  return (
    <div className="db-tab">
      <DbClientView dbId={dbId} onDetach={() => void detach()} onTitle={({ title }) => updateTerminalTitle(terminalId, label ? `${title} (${label})` : title)} />
    </div>
  )
}

export default DbTab
