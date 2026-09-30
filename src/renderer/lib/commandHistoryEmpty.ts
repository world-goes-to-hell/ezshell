export interface HistoryEmptyMessage {
  title: string
  /** Secondary guidance shown on its own line under the title */
  hint?: string
}

/** Empty-state text for the command history popup and panel. */
export function getHistoryEmptyMessage(isAvailable: boolean, totalCount: number): HistoryEmptyMessage {
  if (!isAvailable) return { title: '이 연결은 명령어 기록을 사용할 수 없습니다' }
  if (totalCount === 0) {
    return { title: '아직 기록된 명령어가 없습니다', hint: '터미널에서 명령을 실행하면 여기에 쌓입니다' }
  }
  return { title: '일치하는 명령어가 없습니다' }
}
