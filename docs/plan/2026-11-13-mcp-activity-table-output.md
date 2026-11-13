# MCP 활동: 표 모양 출력을 접지 않고 좌우 스크롤

- 날짜: 2026-11-13
- 구분: 작음 (화면 표시만 바뀐다. 실행·감사 로그·보안 경계와 무관)
- 상태: 구현·확인 완료 (배포 전)

## 요청
MCP 활동 패널에서 DB 조회 결과나 `docker ps` 처럼 표로 찍히는 출력이 창 너비에서 모두 접혀 읽을 수 없다. 접지 말고 칸을 정확히 맞춰 좌우 스크롤로 보이게 한다.

## 결정
- 출력 블록(`.mcp-term-output`)은 줄을 접지 않고(`white-space: pre`) 블록마다 좌우로 스크롤한다. 터미널 보기와 서버별 보기가 같은 요소를 쓴다.
- 패널 머리줄에 `줄바꿈` 버튼을 둔다 (기본 꺼짐, `mcpActivityPrefs` 의 `isOutputWrapped` 로 기억). 긴 로그 한 줄을 읽을 때는 켠다.
- 한글·한자 같은 두 칸 글자: 프로그램은 두 칸으로 세고 칸을 맞추는데, 글꼴이 그리는 폭은 두 칸과 다르다 (12px 에서 한 칸 7.12px, 한글 11.92px). 그런 글자가 이어진 구간을 "칸 수 × 한 칸 너비" 의 상자로 감싸 뒤의 칸이 밀리지 않게 한다.
- 한 칸의 너비는 화면에서 직접 잰다 (`0` 200자의 너비 ÷ 200, 글꼴별로 기억). CSS 의 `ch` 단위는 글꼴 목록 가운데 다른 글꼴의 값을 줄 수 있다: 실제로 7.2px 이 나와 한글이 많은 줄에서 칸 구분선이 4.6px 어긋났다.
- 고정된 요청 카드(마지막 3줄), 목록 보기, 명령 줄은 그대로 둔다.

## 구성
- `src/renderer/lib/terminalCells.ts`(두 칸 글자 판정, 구간 나누기), `components/Mcp/McpActivityTerminal.tsx`(`AlignedText`, `cellWidthOf`), `McpActivityPanel.tsx`(버튼), `McpActivity.css`
- `lib/mcpActivity.ts`, `stores/mcpActivityStore.ts`: 설정 `isOutputWrapped`

## 확인
- [x] 단위 테스트 (`terminalCells.test.ts`, `mcpActivity.test.ts`). 전체 2,402개 통과
- [x] 실제 앱(시험 프로필, 시험용 SSH 서버가 psql 표와 `docker ps` 를 출력): 줄 유지, 좌우 스크롤, 표 5줄이 화면에서도 5줄, 한글이 든 행까지 칸 구분선 7개의 위치 차이 0.0px, `줄바꿈` 켜기·끄기와 기억

## 남은 것
- 휴대폰 화면의 MCP 활동(`src/remoteAccess/web/activity.js`)은 바꾸지 않았다. 같은 문제가 있으면 따로 다룬다.
