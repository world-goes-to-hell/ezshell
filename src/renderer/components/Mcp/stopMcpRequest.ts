import { toast } from '../../stores/toastStore'

/** Ask the main process to stop a waiting or running MCP request ("중지"). */
export async function stopMcpRequest(id: string): Promise<void> {
  const cancel = window.electronAPI?.mcpCancelActivity
  if (typeof cancel !== 'function') return
  try {
    const result = await cancel(id)
    if (!result.success) toast.error('중지하지 못했습니다', '이미 끝났거나 중지할 수 없는 요청입니다.')
  } catch {
    toast.error('중지하지 못했습니다')
  }
}
