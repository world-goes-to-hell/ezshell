# 명령어 기록 자동완성 (후보 목록 팝업)

## 결정 (사용자, 2026-10-01)
- 표시: 커서 아래 후보 목록 팝업
- 조작: ↑↓ 로 고르고 Enter 로 확정
- 범위: 이 연결의 기록만 (기존 기록 저장과 같은 키)

## 안전 기본값 (구현 판단)
- 팝업이 열려도 **처음에는 선택 없음**. ↓(또는 ↑)를 눌러야 선택이 생긴다.
  - 선택 없이 Enter → 팝업만 닫고 Enter 는 셸로 (입력한 그대로 실행)
  - 선택 후 Enter → 그 명령어로 줄을 채우기만 한다 (`Ctrl+E Ctrl+U` + 명령어, 기존 기록 팝업과 같은 방식). 실행은 Enter 한 번 더.
  - 이유: `rm -rf /tmp/a` 를 치고 Enter 했는데 첫 후보 `rm -rf /tmp/abc` 가 들어가는 사고를 막는다.
- Esc: 팝업 닫기 (셸로 보내지 않음). 다음 글자를 치면 다시 열린다.
- Tab: 팝업 닫고 셸의 Tab 완성으로.
- 팝업이 닫혀 있을 때 ↑↓/Enter 는 지금처럼 셸로 (셸 기록 탐색 유지).

## 언제 띄우나
- 입력 줄(프롬프트 뒤, 커서 앞)이 2글자 이상, 커서가 줄 끝(커서 뒤가 공백), 일반 화면 버퍼(vim/top 등 제외)
- 프롬프트를 못 찾는 줄(비밀번호 입력, heredoc 이어지는 줄 등)은 띄우지 않음 — 기록 저장과 같은 기준(`extractCommand`)
- 공백으로 시작하는 입력은 띄우지 않음 (기록에서도 제외하는 입력)
- 후보: 입력으로 **시작하는** 명령어를 최근 순, 모자라면 입력을 **포함하는** 명령어를 최근 순으로, 최대 8개. 입력과 똑같은 명령어는 제외. 일치 부분 강조.

## 구조
| 파일 | 역할 |
|------|------|
| `lib/historySuggest.ts` (+테스트) | `readTypedInput(buffer)` 커서 앞 입력과 커서 뒤가 비었는지, `findSuggestions(entries, typed, limit)`, 팝업 키 처리 `resolveSuggestKey` |
| `hooks/useHistorySuggestions.ts` | 입력 후 화면 갱신(onWriteParsed)마다 후보 계산, 선택 상태, 커서 위치 계산 |
| `components/Terminal/CommandSuggestPopup.tsx` (+css) | 목록 렌더링 (커서 아래, 화면 아래쪽이면 위로) |
| `hooks/useTerminalCommandHistory.tsx` | 위 훅 연결 (handleKeyEvent 에서 팝업 키 우선 처리) |

메인 터미널, 분할 터미널에 적용. 분리된 터미널 창(TerminalWindow)은 기존 기록 기능도 없어서 이번 범위 밖.

## 진행
- [x] lib + 테스트 (`historySuggest.ts`: readTypedInput / findSuggestions / resolveSuggestKey / isTypingInput, 15개), `commandCapture.textAfterPrompt` 추출
- [x] 훅(`useHistorySuggestions.tsx`), 팝업(`CommandSuggestPopup.tsx/.css`), `useTerminalCommandHistory` 에 연결 → 메인/분할 터미널은 수정 없이 적용
- [x] 타입 체크, 전체 테스트 통과
- [x] 코드 리뷰 (CRITICAL/HIGH 없음, MEDIUM 5 모두 반영)
  - IME 조합 중 키는 팝업이 받지 않음 (`isComposing` / keyCode 229)
  - 포커스가 없는 터미널에는 팝업을 띄우지 않음, blur 시 상태 초기화
  - Enter 로 채운 직후 자동 반복 keydown 도 삼킴 (채운 줄이 실행되지 않게)
  - 팝업 시작 위치를 와이드 문자 폭(`cellWidth`)으로 계산
  - 후보 계산을 requestAnimationFrame 으로 합치고 같은 결과면 setState 생략
  - 접근성: 선택 항목 id + 터미널 textarea `aria-activedescendant`
- 구현 메모
  - 셸 ↑ 기록 탐색과의 충돌 방지: 손으로 친 입력(글자, Backspace, 붙여넣기) 뒤에만 연다. ↑ 로 불러온 줄에 팝업이 뜨면 다음 ↑ 를 팝업이 가로채기 때문
  - keydown 에서 처리한 키의 keypress/keyup 도 막는다. xterm 은 keypress 로도 Enter(캐리지 리턴)를 보낼 수 있다
  - 터미널 핸들러는 생성 시 한 번 붙으므로 상태는 ref 로 읽는다
- [x] 1차 E2E: 메인 38개, 분할 11개 항목 통과 (줄 편집 셸 흉내 서버 shell-server.cjs)
- [x] 리뷰 반영 후 재검증: 회귀 통과(분할 첫 프롬프트 유실 1건 제외, 기존 문제), 리뷰 항목 13/13 (포커스 이동, Enter 자동 반복, IME 조합 중 Enter keyCode 229, 한글 위치 1px 이내, aria-activedescendant)
- 별도로 발견 (기존 문제) → 사용자 요청으로 수정, docs/fix/2026-10-01-split-terminal-first-output-lost.md: 분할 터미널을 열 때 서버가 바로 보내는 첫 출력(프롬프트/로그인 메시지)이 사라짐.
  `SplitTerminal.tsx` 의 `handleSplitData` 가 `streamIdRef` 가 정해지기 전 도착한 `ssh-split-data` 를 버림
