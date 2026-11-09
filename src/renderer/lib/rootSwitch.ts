/** How "로그인 후 root 로 전환" went, as the main process reports it (src/rootSwitch.js) */
export type RootSwitchOutcome = 'switched' | 'failed' | 'no-prompt' | 'unknown'

export interface RootSwitchNotice {
  type: 'warning' | 'info'
  title: string
  message: string
}

/** What to tell the user after a connect or reconnect; null when there is nothing to say */
export function rootSwitchNotice(outcome: RootSwitchOutcome | undefined): RootSwitchNotice | null {
  switch (outcome) {
    case 'failed':
      return { type: 'warning', title: 'root 전환 실패', message: 'su 가 거부했습니다. root 비밀번호를 확인하세요. 터미널은 로그인 계정으로 열려 있습니다.' }
    case 'no-prompt':
      return { type: 'warning', title: 'root 전환 확인 필요', message: 'su 가 비밀번호를 묻지 않아 비밀번호를 보내지 않았습니다. 터미널에서 현재 계정을 확인하세요.' }
    case 'unknown':
      return { type: 'info', title: 'root 전환 확인 필요', message: '비밀번호를 보낸 뒤 응답을 확인하지 못했습니다. 터미널에서 현재 계정을 확인하세요.' }
    default:
      return null
  }
}
