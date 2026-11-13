# 터미널 파일 영역 테두리

- 날짜: 2026-11-13
- 구분: 중간 (화면 + 이름 찾기 규칙. 서버 요청은 줄어들기만 함)
- 상태: 진행 중

## 요청
`ls`/`ll` 결과의 이름을 우클릭·Ctrl+클릭할 수 있는데, 어느 영역의 이름이 조작 가능한지 테두리로 보여 준다.

## 확인한 문제
상대 이름은 탭의 지금 폴더(`currentPath`) 기준으로 찾는다. `cd` 전에 찍힌 목록의 이름은 다른 폴더의 파일인데 지금 폴더에서 찾으므로, 같은 이름이 있으면 다른 파일을 연다.

## 설계 (사용자 승인)
- 영역 = 폴더가 마지막으로 바뀐 프롬프트 줄 ~ 지금 커서 줄 바로 위. 폴더가 바뀔 때(스토어의 `currentPath` 변화) 다음 출력이 처리된 뒤 커서 줄에 xterm 표식(`registerMarker`)을 둔다. 표식이 스크롤백 밖으로 밀려 사라지면 버퍼 맨 위부터.
- 그리기: `registerDecoration`(top 층, 클릭 통과). xterm 은 표식 줄이 화면 밖이면 꾸밈을 숨기므로, 보이는 부분만 그린다: 시작이 화면 위로 지나가면 화면 맨 위 줄에 임시 표식을 두고 위 테두리를 뺀다. 오른쪽 위에 기준 폴더 표시.
- 규칙: 영역 밖의 상대 이름은 밑줄·우클릭 메뉴를 내지 않는다. `/`·`~` 로 시작하는 이름은 어디서나.
- 숨김: 폴더 모름(분할 셸 등), 전체 화면 프로그램, 영역에 출력 없음, 사용자가 끔(`편의` 메뉴, `localStorage` 의 `terminalFileZone`).
- 파일: `lib/terminalFileZone.ts`(계산, 테스트), `Terminal/terminalFileZone.ts`(표식·그리기), `TerminalPanel.tsx`, `terminalFileLinks.ts`, `terminalTargetMenu.tsx`, `useTerminalContextMenu.tsx`, CSS.

## 진행
- [x] `terminalFileZone.test.ts`(10개) → `lib/terminalFileZone.ts`
- [x] 표식·그리기, 링크·메뉴 규칙, `편의` 켜기/끄기
- [x] 타입 체크, 테스트(전체 2,284개), 빌드, CLAUDE.md
- [ ] 실제 앱 확인 (테두리 위치, 스크롤, cd 직후)
