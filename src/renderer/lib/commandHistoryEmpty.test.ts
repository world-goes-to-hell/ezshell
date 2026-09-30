import { describe, it, expect } from 'vitest'
import { getHistoryEmptyMessage } from './commandHistoryEmpty'

describe('getHistoryEmptyMessage', () => {
  it('explains that history is unavailable for this connection', () => {
    expect(getHistoryEmptyMessage(false, 0)).toEqual({ title: '이 연결은 명령어 기록을 사용할 수 없습니다' })
  })

  it('splits the no-history message into a title and a hint', () => {
    expect(getHistoryEmptyMessage(true, 0)).toEqual({
      title: '아직 기록된 명령어가 없습니다',
      hint: '터미널에서 명령을 실행하면 여기에 쌓입니다'
    })
  })

  it('reports no matches when history exists but the search filtered everything out', () => {
    expect(getHistoryEmptyMessage(true, 5)).toEqual({ title: '일치하는 명령어가 없습니다' })
  })
})
