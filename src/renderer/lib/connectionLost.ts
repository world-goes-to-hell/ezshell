/** Connection state of a terminal (a tab in the main window, or a popped-out terminal window) */
export interface ConnectionLink {
  connected: boolean
  /** Automatic reconnect in progress after the connection dropped */
  reconnect: { attempt: number; maxAttempts: number } | null
  /** Why the connection could not be brought back */
  disconnectNote: string | null
}

export const linkConnected = (): ConnectionLink => ({ connected: true, reconnect: null, disconnectNote: null })

export const linkReconnecting = (attempt: number, maxAttempts: number): ConnectionLink =>
  ({ connected: false, reconnect: { attempt, maxAttempts }, disconnectNote: null })

/** Without a `note` the reason already shown is kept: main sends a close right after the failure message */
export const linkDisconnected = (previous: { disconnectNote?: string | null }, note?: string): ConnectionLink =>
  ({ connected: false, reconnect: null, disconnectNote: note ?? previous.disconnectNote ?? null })

/** What the "연결 끊김" overlay of a terminal tab says */
export interface ConnectionLostView {
  title: string
  detail: string
  /** Something is being tried right now (shows a spinner) */
  isWorking: boolean
  /** The 재연결 / 종료 buttons can be pressed */
  canAct: boolean
}

interface ConnectionLostState {
  /** Automatic reconnect in progress (from the main process) */
  reconnect?: { attempt: number; maxAttempts: number } | null
  /** Why the connection could not be brought back */
  note?: string | null
  /** The user pressed 재연결 and it has not answered yet */
  isReconnecting?: boolean
}

const TITLE = '연결 끊김'

export function describeConnectionLost({ reconnect, note, isReconnecting }: ConnectionLostState): ConnectionLostView {
  if (isReconnecting) return { title: TITLE, detail: '다시 연결하는 중입니다.', isWorking: true, canAct: false }
  if (reconnect) {
    return {
      title: TITLE,
      detail: `자동으로 다시 연결하는 중입니다 (${reconnect.attempt}/${reconnect.maxAttempts}).`,
      isWorking: true,
      canAct: true
    }
  }
  return {
    title: TITLE,
    detail: note || '서버와의 연결이 끊겼습니다. 다시 연결하거나 탭을 닫으세요.',
    isWorking: false,
    canAct: true
  }
}

/** The reason the main process gave for giving up on reconnecting, in Korean */
export function reconnectFailureText(message: string | undefined): string {
  if (!message) return '자동 재연결에 실패했습니다.'
  const limit = /Maximum reconnection attempts reached \((\d+)\)/.exec(message)
  if (limit) return `자동 재연결을 ${limit[1]}번 시도했지만 실패했습니다.`
  return message
}
