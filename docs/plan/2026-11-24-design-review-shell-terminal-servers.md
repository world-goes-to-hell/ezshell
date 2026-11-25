# 디자인 리뷰: 본창 구조 · 터미널 · 서버 작업 화면 · 설정

2026-11-24, `/plan-design-review` 로 진행. 리뷰만 하고 코드는 고치지 않았다. 에이전트 경험·작업 공간 패널·휴대폰 원격 접속은 claude-2 의 리뷰 범위다.

- 범위: 1) 본창 구조(타이틀바, 사이드바, 탭 줄과 작업 묶음, 상태 줄, 시작 화면, 명령 팔레트, 잠금 화면, 업데이트 안내, 탭 다시 열기 안내, 작업 개요), 2) 터미널 영역(칸 분할·손잡이·놓을 자리, 연결 끊김 덮개, 우클릭 메뉴, 파일 영역 테두리, 로그 강조), 3) 서버 작업 화면(SFTP·파일 탐색기, 서버 파일 창, DB 탭, 컨테이너 패널, MCP 활동·확인 창, 브라우저 탭), 4) 설정 모달 전체.
- 깊게 본 곳(사용자 선택): 본창 구조, 서버 작업 화면. 터미널 영역과 설정은 코드와 화면 캡처 위주로 봤다.
- 방법: 영역별 코드 감사 셋(본창 구조 / 서버 작업 화면 / 터미널·설정·디자인 토큰)을 따로 돌렸다. 빌드된 화면(`out/renderer`)을 가짜 `electronAPI` 로 띄워 55장을 캡처했다 (잠금 화면, 시작 화면, 사이드바, 명령 팔레트, 설정 모든 탭, 새 연결 창, 다크·One Light·macOS 밝은/어두운 테마). 우선순위 높은 지적은 코드에서 직접 다시 확인했다.
- 기준: DESIGN.md 가 없다. 그래서 CLAUDE.md 의 해당 절, `docs/plan/` 의 설계, `mockups/`, `variables.css` 와 테마 정의, 일반적인 디자인 원칙(위계, 상태, 대비, 키보드)을 기준으로 삼았다.
- 화면을 띄울 수 없어서 캡처하지 못한 것: 터미널, SFTP, DB, 컨테이너, MCP 활동(데이터가 있을 때). 이것들은 코드만 보고 판단했다.

## 점수

| 차원 | 지금 | 결정대로 고친 뒤(목표) | 한 줄 |
|---|---|---|---|
| 1. 정보 구조·위계 | 6 | 8 | 층은 분명하다. 하지만 "지금 보는 세션", "어느 서버에 하는 동작인가"가 위에 오지 않고, 설정은 탭이 세 겹이다 |
| 2. 상태 처리 | 5.5 | 8 | 로그 보기·DB 진행·복원 배너는 좋다. 상태 줄 연결 수, 업데이트 실패, 탭 넘침, SFTP 오류가 비어 있거나 틀렸다 |
| 3. 사용 흐름 | 6 | 8 | 저장 전 diff·백업, 잠금, 복원은 탄탄하다. 첫 실행(옮겨 오기)과 매일 보는 시작 화면이 빈약하다 |
| 4. 흔한 생성형 패턴 | 7.5 | 9 | 대부분 각지고 평평해서 의도가 보인다. 잠금 화면(빛나는 방패·그라디언트 타일)과 옛 팔레트 흔적만 남았다 |
| 5. 디자인 시스템 | 5 | 8 | 색 토큰은 우수하다(`var()` 4,345곳). 글자 크기 토큰 0개(px 733곳), z-index 40종 이상, 메뉴 9종, 툴바 방식 3종 |
| 6. 접근성·좁은 창 | 5 | 7.5 | 전역 포커스 링, 트리 키보드, 동작 줄이기 CSS 는 좋다. 옛 테마의 흐린 글자 대비 2.2~2.9:1, 탭·구분선·탐색기는 키보드로 못 쓴다 |
| **전체** | **5.5** | **8** | |

## 결정한 것 (사용자 답, 2026-11-24)

| # | 질문 | 결정 |
|---|---|---|
| D3 | 운영 서버 표지 범위 | **모든 서버 작업 화면.** 저장·삭제·충돌 확인 창, 서버 파일 창 제목, SFTP 머리, DB 탭 툴바에 세션 색 네모 + 세션 이름 + `계정@호스트`. DB 배지는 서버 강제가 없으면 경고색 `읽기 전용 (앱 검사)` |
| D4 | MCP 확인 창 배치 | **위험도·명령 우선.** 위험도 배지는 제목 옆, 명령은 사유보다 위. 긴 명령은 끝까지 봐야 허용. 머리줄·버튼 줄 고정, `대기 N건`, 10초 이하이면 남은 시간 빨강 |
| D5 | 탭 넘침 | **최대 폭 + 가로 스크롤.** 탭 최대 200px + 말줄임, 휠로 가로 이동, 앞 탭은 보이는 자리로, `+` 는 줄 밖에 고정 |
| D6 | 토큰·DESIGN.md | **DESIGN.md + 토큰 단계적 도입.** 새 코드는 곧바로 쓰고, 기존 화면은 고칠 때마다 옮긴다. 공용 Menu·IconButton 부품 |
| D7 | 시작 화면 | **최근 접속 + 첫 실행 안내.** 세션이 있으면 최근 접속 5개·로컬 터미널·단축키 안내, 없으면 새 연결·다른 프로그램에서 가져오기·텍스트로 추가·로컬 터미널. 사이드바 빈 상태에도 같은 버튼 |
| D8 | 설정 구조 | **왼쪽 세로 목록 + 검색.** 창 크기에 맞춘 설정 창, 특정 설정으로 바로 여는 길(`initialTab`) |
| D9 | Alt 끌기로 셸 닫기 | **실행 중일 때만 확인.** 닫을 셸에서 프로그램이 돌고 있으면 놓을 때 확인 창 |
| D10 | 옛 테마 흐린 글자 대비 | **모두 4.5:1 로 올림.** 대비 검사 테스트를 모든 프리셋에 건다 |

## P1: 먼저 고칠 것 (사실과 다른 표시, 안전, 매일 쓰는 데 지장)

코드에서 직접 다시 확인한 것은 ✔ 로 표시했다.

1. ✔ **DB "읽기 전용" 배지가 사실과 다른 안심을 준다.** `DbClientView.tsx:394-396` 의 안내가 늘 "DB 서버가 쓰기를 거부하도록 접속했습니다"이다. `info.missingGuards` 가 있는 SQL Server(세션을 읽기 전용으로 둘 수 없음)·Oracle 일부에서도 같은 초록 방패가 나온다. 경고 `일부 서버 측 제한 없음`(`.db-guard-warning`, `DbClient.css:469`, nowrap)은 좁은 툴바에서 잘리고 자세한 내용은 툴팁에만 있다. → D3: `missingGuards` 가 있으면 배지 자체를 경고색 `읽기 전용 (앱 검사)` 로 바꾸고 안내도 맞춘다.
2. **되돌릴 수 없는 확인 창에 서버가 안 보인다.** 저장 확인(`RemoteFileDialogs.tsx:41-51`)은 경로와 +/- 줄 수만, 원격 삭제(`lib/sftpRemoteDelete.ts:40-47`)는 "원격 서버에서 N개 항목"만 적는다. → D3: MCP 확인 창의 세션 이름 + 세션 색 네모를 같은 모양으로 넣는다. 충돌 창의 `다시 불러오기 (내 변경 버림)`(`RemoteFileDialogs.tsx:107`)은 `취소` 와 같은 `btn-secondary` 인데, 위험 스타일로 바꾼다.
3. ✔ **MCP 확인 창이 AI 의 설명을 먼저 읽게 하고, 긴 명령은 다 보지 않아도 허용된다.** 순서가 `요청 사유`(`McpApprovalDialog.tsx:146`) → 명령(165) → `위험도`(181)이다. 명령 상자는 `max-height:160px` 로 스크롤되는데 "끝까지 봐야 허용"은 diff 에만 걸린다. `.modal-content` 의 `max-height:85vh; overflow-y:auto`(`modal-form.css:24-26`) 때문에 창이 길면 남은 시간과 버튼도 스크롤된다. main 의 대기열(`src/mcp/approval.js`)은 창에 보이지 않는다. → D4.
4. ✔ **상태 줄 "N개 연결됨"이 끊긴 탭도 센다.** `Footer.tsx:19` 가 `isSshTab` 개수만 센다. 모든 탭이 끊겨도 초록 와이파이 아이콘에 "3개 연결됨"이 나와서, 사이드바 접힌 띠의 연결·끊김 수와 어긋난다. → `connected` 기준으로 세고, 끊긴 탭이 있으면 `2 연결 · 1 끊김`(끊김은 빨강).
5. ✔ **업데이트 다운로드가 실패하면 알림이 말없이 사라진다.** `isUpdateNoticeVisible`(`lib/updateCheck.ts:10`)은 available/downloading/downloaded 만 보여 준다. `error` 가 되면 진행 막대가 그냥 없어진다. → 오류 카드("다운로드하지 못했습니다 · 다시 시도 / 다운로드 페이지")를 두고, 상태 줄 버전 옆에 경고 표지를 단다.
6. ✔ **탭이 넘치면 오른쪽 탭과 `+` 가 잘린다.** 일반 `.terminal-tab` 에는 max-width·말줄임이 없고(브라우저 탭만 있음, `terminal-tabs.css:63`), `.terminal-tab-items`(`:27`)에도 넘침 처리가 없다. 부모 `.main-area` 는 `overflow:hidden` 이다. → D5.
7. ✔ **SFTP·탐색기가 오류를 감추거나 영어로 알린다.** `FileExplorer.tsx:59-61` 은 폴더를 못 읽으면 빈 배열을 돌려줘서, 권한 없는 폴더가 빈 폴더처럼 보인다. `SftpPanel.tsx:130,216,276,281` 의 토스트는 'SFTP initialization failed', 'Failed to load remote files', 'Unknown error' 로 영어다. `FileList.tsx` 에는 빈 폴더 표시가 없어 `..` 한 줄만 남는다. → 탐색기는 그 폴더 줄 아래에 이유를 적고, 문구는 `sftpRemoteDelete.ts` 의 한국어 변환을 함께 쓴다. SFTP 목록에는 "빈 폴더" 안내를 둔다.
8. ✔ **컨테이너 `재시작`·`중지` 는 실행 버튼처럼 생겼는데 실행하지 않는다.** `ContainerPanel.tsx:236-246` 이 `로그`·`이름` 과 같은 버튼 모양이다. "입력줄에 넣기만 한다"는 툴팁과 맨 아래 작은 글(`:257`)에만 있다. 사용자는 "눌렀는데 아무 일도 없다"고 느끼거나, 입력줄에 남은 `docker stop x` 를 잊고 다음 Enter 때 실행한다. → 버튼 이름을 `중지 명령 넣기` 로 하거나 키보드 아이콘을 붙인다. 넣은 뒤에는 "입력줄에 넣었습니다 · Enter 로 실행" 안내를 띄우고 그 터미널에 포커스를 준다 (넣기만 하는 정책은 CLAUDE.md "바꾸면 안 되는 것"이라 유지).
9. **Alt+끌기가 확인 없이 셸을 닫는다.** `SplitChrome.tsx:207,209`("놓으면 이 셸을 닫습니다")의 동작이고, `usePaneGesture.ts` 에 확인이 없다. Windows Terminal 에서 Alt+끌기는 사각형 선택이다. → D9: 닫을 셸에서 프로그램이 돌고 있으면 놓을 때 확인한다 (로컬은 셸의 자식 프로세스, SSH 는 셸이 프롬프트 상태인지로 판단. 판단 방법은 구현 때 정한다).
10. ✔ **옛 테마의 흐린 글자가 읽기 어렵다.** 11~12px `--text-muted`(344곳)의 `bg-secondary` 대비는 다음과 같다: One Dark Pro 2.55(직접 계산: `#5c6370`/`#21252b`), Monokai Pro 2.16, Tokyo Night 2.35, Solarized Light 2.18, Catppuccin Mocha 2.57, GitHub Light 2.89, Dracula 3.03. 기본 Minimal 두 테마와 macOS 는 통과한다 (minimal-light 의 `bg-tertiary` 위는 4.12). 원인: `presets.test.ts:53,88-97` 의 4.5:1 검사가 채팅 짝 테마에만 걸려 있다. → D10.

## 영역별 지적 (P2·P3)

### 본창 구조

- **P2 사이드바 강조가 "연결됨"이다.** `SessionItem.tsx:67`(`isActive = connected>0`)과 `sidebar.css:276` 때문에 연결된 세션 5개가 모두 강조색이고, `aria-selected`(`:105`)로 모두 "선택됨"으로 읽힌다. 지금 앞에 있는 탭의 세션은 표시되지 않는다. → 연결 상태는 점·배지로만 보이고, 강조와 `aria-current` 는 앞 탭의 `savedSessionId` 세션 하나에만 준다 (권장. 아래 "열린 결정"에 남김).
- **P2 세션 로딩 상태가 없다.** `SessionList.tsx:793` 의 `isEmpty` 는 로딩 중인지 모른다. 그래서 잠금 해제 직후 "저장된 연결이 없습니다"가 잠깐 보일 수 있다. 시작 화면은 `areSessionsLoading` 을 본다(`App.tsx:1763`). → 사이드바에도 로딩 표시.
- **P2 첫 실행에서 옮겨 오는 경로가 숨어 있다.** 빈 상태는 글자뿐이고(`SessionList.tsx:823-827`), 시작 화면에는 `새 연결` 하나만 있다(`WelcomeScreen.tsx:34`). → D7.
- **P2 잠금 화면 문구와 접근성.** "비밀번호 저장"(`LockScreen.tsx:413`)은 실제로 "이 PC 에서 자동 잠금 해제"(safeStorage)다. 처음 설정할 때 "복구할 수 없다"는 안내가 없다(`:287-293`). `<label>` 에 htmlFor 가 없고(`:311,369`), 오류 문구에 `role="alert"` 가 없고(`:393`), 눈 버튼은 `tabIndex=-1` 에 이름이 없다(`:327`).
- **P2 잠금 화면의 시각 언어가 본창과 다르다.** 가운데 카드, 흐린 빛을 두른 방패(`lock-screen.css:87-94`), 그라디언트 아이콘 타일(`:111`), 애니메이션 배경이 있다. 테마와 무관한 색도 하드코딩되어 있다: 성공 빛 `rgba(35,165,90)`(`:75`), 오류 배경 `rgba(243,139,168)`(`:396`, 옛 팔레트 분홍). → 본창과 같은 평면 언어로 바꾸고 색은 토큰으로 (권장. 열린 결정).
- **P2 명령 팔레트 단축키가 하드코딩되어 있다.** `CommandPalette.tsx:98,108,192` 의 `'Ctrl+N'`·`'Ctrl+,'`·`'Ctrl+Shift+S'` 는 사용자가 단축키를 바꾸거나 macOS(⌘)에서 쓰면 틀린 키를 보여 준다. → `shortcutsStore` 에서 읽는다. 팔레트는 포커스를 가두지 않아 Tab 을 누르면 뒤 앱으로 빠진다. `aria-label="Command palette"` 는 영어다(`:379`).
- **P2 탭에 키보드 포커스가 가지 않는다.** 탭이 `motion.div` + onClick 이다(`App.tsx:1566-1572`). → `role="tablist"`/`tab` + `aria-selected` + 로빙 tabIndex + ←/→ 이동.
- **P2 활성 탭 글자가 세션 색 그대로다**(`App.tsx:1584-1589`). 어두운 남색·노랑 세션 색은 대비가 3:1 아래로 떨어진다. → 글자는 `--text-primary`, 세션 색은 밑줄·점으로 (또는 `lib/pointerInk.ts` 처럼 대비 보정).
- **P3 제목줄이 늘 "ezShell"이다**(`TitleBar.tsx:18`). `작업명 · 탭 제목` 을 넣으면 Alt+Tab 에서도 구분된다. 접힌 띠 숫자는 모두 `aria-hidden` 이다(`Sidebar.tsx:272-306`). "Loading settings..."(`App.tsx:1554-1556`)와 skip link "Skip to main content"(`:1522`)는 영어다. `.terminal-tab.has-activity` 의 `border-color`(`terminal-tabs.css:149`)는 탭이 `border:none` 이라 효과가 없다.
- **P3 업데이트 뒤 첫 잠금 해제에서 "업데이트 내용" 모달과 탭 복원 배너가 동시에 뜬다**(`App.tsx:1094`, `:1170`). 열린 결정에 넣었다.
- 잘된 것: 세션 트리 `role=tree` 키보드 이동, 검색이 목록을 거르지 않고 강조만 하는 것, 복원 배너의 단계(묻기/진행/결과)와 부분 실패 목록, 작업 개요의 포커스 복귀, 배지 숫자를 본문 글자색으로 둔 대비 처리.

### 터미널 영역

- **P2 셸이 스스로 끝났는데 제목이 "연결 끊김"이다.** `lib/connectionLost.ts:38` 과 `ConnectionLostOverlay.tsx:84-90` 이 빨간 끊긴 링크 아이콘을 쓰는데, 본문은 "셸이 종료되었습니다…"다. → `kind: 'exited'` 를 두어 제목을 "셸 종료"로, 아이콘을 중립색으로, 버튼을 "새 셸 열기"로 한다.
- **P2 연결 끊김 카드에 키보드로 닿을 수 없다.** 일부러 포커스를 받지 않는데, xterm 의 Tab 은 셸로 간다. 그런데도 `role="alertdialog"`(`:78`)라 화면 읽기 프로그램은 모달로 알린다. → 명령 팔레트에 `재연결` 을 넣고 단축키 힌트를 보인다. role 은 `alert`/`region` 으로 바꾼다.
- **P2 칸 구분선·손잡이는 마우스로만 쓴다**(`SplitChrome.tsx:237-245,276`: 포커스 불가, `role="separator"` 없음, 손잡이 높이 14px 에 `aria-hidden`). → 구분선에 separator role 과 방향키, 우클릭 `분할` 에 칸 옮기기를 둔다.
- **P3 우클릭 메뉴에 단축키 표시와 위험 표시가 없다**(`TerminalContextMenu.tsx:33-40`). `연결 종료`·`이 칸 닫기` 가 다른 항목과 모양이 같다. `편의` 하위 메뉴(`useTerminalContextMenu.tsx:164`)는 이름으로는 무엇이 들었는지 알 수 없다 (찾기 / 출력 / 보기로 나누기). 놓을 수 없는 칸은 미리보기만 빨갛고 바깥 테두리는 accent 점선이다(`terminal-split.css:275-279,310-313`). `.pane-drop-zone.is-over` 가 두 번 정의되어 있다(275, 286). 파일 영역 테두리만 둥글다(`terminalFileZone.css:6`). 폴더 이름표는 10.5px accent 글자에 opacity .9 로 대비가 약 3.3 이다(`:27-37`). 로그 강조의 오류·경고 막대는 색만 다르다(`terminalLogHighlight.css:9-16`): 오류만 3px 로 하거나 경고를 점선으로.
- 잘된 것: 놓을 자리 미리보기와 막힌 이유 문구(`SplitChrome.tsx:22-23`), 재연결 시도 횟수 표시, 칸 감싸개 key 고정 같은 구조적 배려.

### 서버 작업 화면

- **P2 고정 색이 테마를 깬다** (`sftp.css`).
  - 파일 종류 아이콘 색이 옛 팔레트 값이다(350-361). 밝은·macOS 테마에서는 흰 바탕에 `#a6e3a1` 이 되어 대비 약 1.5:1 이다.
  - 선택·끌어 놓기 바탕도 `rgba(137,180,250,.15)` 로 고정이다(144, 269, 323).
  - → 바탕은 `--accent-muted`, 아이콘은 테마별 `--file-*` 토큰.
- **P2 툴바가 세 방식이다.**
  - 컨테이너는 서버 모니터의 `monitor-*`(28px), DB 는 `db-icon-button`(24px), 파일 창은 `popout-title-action` 이다.
  - 중지 버튼도 `mcp-activity-stop`·`mcp-term-stop` 두 가지다.
  - → D6 의 공용 IconButton.
- **P2 키보드로 다니기 어렵다.**
  - DB 트리는 `role="tree"` 인데 화살표 키가 없다. 테이블 하나에 Tab 정지가 세 번이다(`DatabaseTree.tsx:131-148`).
  - 파일 탐색기 줄은 tabIndex 없는 `div onClick` 이다(`FileExplorer.tsx:325-333`).
  - `DbConsole.tsx:175-177` 의 `role="status"` 안에서 경과 시간이 계속 바뀌어, 화면 읽기 프로그램이 계속 읽는다.
- **P2 컨테이너 줄의 버튼이 많다.** 줄마다 버튼 다섯 개(약 22px)라 50개면 250개다. 포인터·포커스가 있을 때만 보이거나 `⋯` 메뉴로 접는다 (열린 결정).
- **P2 MCP 활동 빈 상태가 "아직 MCP 요청이 없습니다."뿐이다**(`McpActivityPanel.tsx:184`). 서버가 꺼져 있다면 그 사실과 켜는 링크를 함께 보인다.
- **P2 MCP 실행 기록 응답 하나가 앱 전체를 비울 수 있다.** 캡처 중 발견: `McpAuditList.tsx:17` 이 `setEntries(result.entries)` 를 검사 없이 한다. `entries` 가 없는 실패 응답이면 렌더 오류로 화면 전체가 하얗게 된다. → `result.entries ?? []`. 디자인보다 버그지만 사용자가 보는 결과라 적어 둔다.
- **P3** 말줄임 `불러오는 중...`(`ContainerPanel.tsx:193`)만 마침표 셋이다. `db-run-button kbd` 의 `#000`(`DbClient.css:431`). `999px` 알약(`.db-readonly-badge`, `RemoteCompare.css`)이 각진 테마에 섞인다.
- 잘된 것:
  - 실시간 로그 보기(새 파일 감지, 건너뛴 양, 급증·`새 오류`, 수준별 이동)는 업계 수준 이상이다.
  - 서버 파일 저장 흐름(diff 검토 → 백업 → 저장, 잘린 diff 체크, 충돌 비교)이 탄탄하다.
  - MCP 확인 창의 안전장치(0.8초 대기, 보이지 않는 문자 표시, 정렬과 원문이 다르면 원문만)가 잘 되어 있다.
  - 큰 폴더는 보이는 줄만 그리고 진행 수를 보여 준다.
  - 경로 입력줄의 콤보박스 ARIA(`PathBar.tsx:141-148`), DB 1,000행 잘림 경고가 좋다.

### 설정 모달

- **P2 탭 세 겹, 고정 크기.**
  - 캡처에서 앱 창이 1440×900 이어도 설정 창은 700×600px 이다. 테마 → 앱 테마·채팅 테마·창 효과·포인터 모양·포인터 효과·브라우저 탭 → 전체·다크·라이트·특수·커스텀이 겹쳐, 테마 목록이 보이는 높이가 약 240px 다.
  - 기능 위치가 예상과 다르다: "쉬는 에이전트의 메모리"는 MCP > 에이전트 메시지(`SettingsModal.tsx:171`), "브라우저 탭 폭"은 테마(`ThemeSettings.tsx:15`), 다른 프로그램 가져오기는 백업의 셋째 하위 탭이다.
  - 특정 탭으로 여는 prop 이 없다(`SettingsModal.tsx:24-26`).
  - → D8.
- **P2 잘못된 입력은 토스트만 띄우고 값을 되돌린다.** MCP 포트(`McpSettings.tsx:76-81`)가 그렇다. → 입력칸 아래 오류 + `aria-invalid`, 사용자가 넣은 값은 유지.
- **P2 확인을 OS 대화상자로 받는다.** 토큰 재발급·클라이언트 설정이 `window.confirm` 을 쓴다(`McpSettings.tsx:87`, `McpClientSetup.tsx`). 테마를 따르지 않는다. → 앱의 `ConfirmDialog`.
- **P3**
  - Glass 는 "다시 시작하면 적용" 안내만 있고 바로 다시 시작하는 버튼이 없다(`WindowAppearanceSettings.tsx:26`).
  - 섹션 제목마다 탭과 같은 아이콘이 반복된다(`SettingsModal.tsx:96-104`).
  - `role="radio"` 묶음이 방향키를 받지 않는다(`PointerSettings.tsx:37-42,50`).
  - aria-label 12개가 영어다(`SettingsModal.tsx:56` "Close", `FontSizeControl.tsx:46-76`).
  - Radix 경고 "Missing `Description`"이 설정·새 연결·빠른 연결 창마다 한 번씩 뜬다.
  - MCP 하위 탭의 활성 글자색(accent)은 minimal-dark 에서 대비 3.70 이다(`settings.css:119-123`).

### 디자인 시스템 (전체)

- **글자 크기:** `font-size` 선언 743개 중 토큰은 0개다 (확인: `var()` 0, px 733).
  - 많이 쓰인 값: 13px 222, 12px 182, 11px 97, 14px 72, 15px 45, 12.5px 38, 11.5px 22, 10px 17. 11px 미만이 26곳이다(최저 `SidebarTree.css:418` 9px).
  - 같은 "목록 줄"인데 세션 줄은 14px, 트리 재정의는 13px, 로컬 작업은 11~12px 다.
- **간격:** padding 792개, gap 값이 8·6·4·12·10·2·5·3·16·7px 로 흩어져 있다.
- **z-index:** 1~20001 에 40가지가 넘는다. 질서는 CLAUDE.md 본문에만 있다.
- **모서리:** 기본은 각지게(`variables.css:14-20`)다. 그런데 직접 쓴 `3px` 12곳, `999px` 10곳, `var(--radius-md, 6px)` 대체값 20곳이 있다. macOS 테마의 `--radius-*` 전환을 받지 못한다.
- **부품:**
  - 메뉴 약 9종(`terminal-menu`, `context-menu`, `tab-context-menu`, `new-tab-menu`, `db-menu`, `agent-picker-menu` …).
  - `-btn` 계열 클래스 68종.
  - `.btn-primary`·`.btn-secondary` 가 두 곳씩 정의되어 있다(`main-content.css:31`·`SnippetManager.css:219`, `modal-form.css:341`·`QuickConnectModal.css:82`). 결과가 불러오는 순서에 달린다.
  - 상태 줄 항목은 클래스가 제각각이고 공통 `.status-item` 이 없다.
  - 아이콘 크기는 13~20px 로 6종이다.
- **고대비:** `@media (prefers-contrast: high)`(`accessibility.css:39`)는 표준 키워드가 아니라(`more` 가 맞다) 동작하지 않는다. 고쳐서 살리면 `:root{--border:#fff}` 가 밝은 테마에서 흰 바탕에 흰 선이 된다. → 테마의 밝기에 따라 나눈다.
- **움직임:** framer-motion 애니메이션 12곳은 CSS 동작 줄이기 규칙을 받지 않는다. → 앱 루트를 `<MotionConfig reducedMotion="user">` 로 한 번 감싼다.
- **툴팁:** 테마 툴팁은 포인터에만 반응한다(`themedTooltip.ts:153`). 비활성 버튼의 이유를 키보드 사용자는 볼 수 없다.
- 잘된 것:
  - 색 토큰이 역할 이름이다(`--bg-*`, `--text-*`, `--on-accent`, `--error-text`). 컴포넌트 CSS 의 직접 hex 는 23곳뿐이다.
  - UI 글꼴이 정해져 있다(Pretendard Variable 로컬, JetBrains Mono, D2Coding).
  - 그라디언트를 평면 색으로 바꾼 결정(`variables.css:83-86`).

#### 토큰 제안 (D6, DESIGN.md 의 초안)

```
글자   --text-2xs 10 · --text-xs 11 · --text-sm 12 · --text-md 13(기본) · --text-lg 15 · --text-xl 18
       12.5 → 12 또는 13, 11.5 → 11 또는 12, 13.5 → 13, 10.5 → 10 또는 11 (화면별로 위계를 보고 고른다)
간격   --space-1 4 · -2 8 · -3 12 · -4 16 · -5 24 · -6 32  (2px 는 테두리·미세 조정만)
레이어 --z-pane 1 · --z-overlay 10 · --z-panel 95 · --z-modal 100 · --z-toast 900 · --z-menu 1000
       --z-tooltip 10000 · --z-pointer-fx 10050 · --z-confirm 15000 · --z-hostkey 16000 · --z-approval 20000
모서리 --radius-sm/md/lg 는 테마가 정함(기본 0, macOS 둥글게). 예외로 남길 것: 상태 점·배지(--radius-full)
부품   IconButton(24px 기본, 28px 큼), Menu(Radix 기반 하나), StatusItem, ServerBadge(세션 색 네모 + 이름 + 계정@호스트)
```

이름은 크기식(`--text-sm`)으로 제안한다. 역할식(`--text-label`)이 테마별 밀도 조정에는 유리하다. 하지만 지금 743곳을 옮기는 데는 크기식이 기계적으로 맞추기 쉽다.

## 상태 처리 표 (지금 → 정할 모습)

| 기능 | 로딩 | 비었음 | 오류 | 성공 | 일부 |
|---|---|---|---|---|---|
| 사이드바 세션 목록 | 없음 → 줄 3개 자리 표시 | 글자뿐 → D7 버튼 넷 | 해당 없음 | 트리 | 검색 0건 "없음" (좋음) |
| 시작 화면 | 로고 | 로고 → D7 | 해당 없음 | 해당 없음 | 해당 없음 |
| 상태 줄 연결 | 해당 없음 | "연결 없음" | 끊긴 탭도 "연결됨" → `N 연결 · M 끊김` | 같음 | 같음 |
| 업데이트 알림 | 진행 막대 | 해당 없음 | 사라짐 → 오류 카드 + 다시 시도 | "재시작" | 해당 없음 |
| 탭 줄 | 해당 없음 | `+` 만 | 해당 없음 | 탭 | 넘치면 잘림 → D5 |
| SFTP 목록 | "불러오는 중… N개" (좋음) | `..` 만 → "빈 폴더" | 영어 토스트 → 한국어 + 목록 안 안내 | 목록 | 해당 없음 |
| 파일 탐색기 | 표시 있음 | 빈 폴더 | 빈 폴더로 위장 → 줄 아래 이유 | 트리 | 300개씩 `더 보기` (좋음) |
| DB 콘솔 | 경과 초 (좋음, 단 화면 읽기는 반복) | 해당 없음 | 메시지 | 결과 표 | 1,000행 경고 (좋음) |
| DB 읽기 전용 배지 | 해당 없음 | 해당 없음 | 서버 강제 없음 숨김 → 경고색 배지 | 초록 방패 | 해당 없음 |
| 컨테이너 패널 | `불러오는 중...` | 있음 | 있음 | 목록 | 200개 잘림 안내 (좋음) |
| MCP 확인 창 | 해당 없음 | 해당 없음 | 시간 초과 시 거부 | 허용 | 대기열 안 보임 → `대기 N건` |
| MCP 활동 | 해당 없음 | 꺼짐과 구분 안 됨 → 꺼짐이면 켜는 링크 | 있음 | 목록 | 해당 없음 |
| 연결 끊김 덮개 | 재연결 N회 (좋음) | 해당 없음 | 이유 표시 | 사라짐 | 셸 종료도 "연결 끊김" → "셸 종료" |
| 설정 입력 | 저장 표시 없음 | 해당 없음 | 토스트 + 값 되돌림 → 칸 아래 오류 | 반영 | 해당 없음 |

## 사용 흐름 (지금 기준)

| 단계 | 사용자가 하는 일 | 느낌 | 지금 받쳐 주는 것 |
|---|---|---|---|
| 1 | 처음 실행, 마스터 비밀번호 정함 | 조심스러움 | 비밀번호 화면. 복구 불가 안내 없음, "비밀번호 저장"의 뜻이 불분명 |
| 2 | PuTTY 세션을 옮기고 싶음 | 막막함 | 설정 > 백업 > 셋째 하위 탭에 숨어 있음 → D7 |
| 3 | 첫 접속 | 기대 | `새 연결` 창 (좋음) |
| 4 | 매일 켬 | 빨리 일하고 싶음 | 빈 로고 화면 → D7 최근 접속 |
| 5 | 탭 여러 개로 작업 | 몰입 | 탭이 넘치면 잘림, 지금 세션이 사이드바에 안 보임 |
| 6 | 운영 서버 설정 파일 저장 | 긴장 | diff·백업 (좋음). 어느 서버인지 창에 없음 → D3 |
| 7 | 에이전트의 MCP 명령 승인 | 시간 압박 | 안전장치는 좋음. AI 설명이 먼저, 긴 명령 끝까지 안 봐도 허용 → D4 |
| 8 | 연결이 끊김 | 불안 | 재연결 카드 (좋음). 키보드로 닿지 못함, 셸 종료도 같은 제목 |
| 9 | 업데이트 | 귀찮음 | 진행 막대. 실패하면 사라짐 |

## 열린 결정 (이번에 묻지 않았고, 권장안을 적어 둠)

| 결정 | 권장 | 미루면 |
|---|---|---|
| 상태 줄 연결 표시의 뜻 | `N 연결 · M 끊김`, 로컬 터미널은 세지 않음 (P1-4) | 사실과 다른 "연결됨"이 계속 보임 |
| 사이드바 강조 기준 | "지금 보는 세션" 하나만 강조, 연결은 점·배지 | 연결 많은 날 강조가 의미를 잃음 |
| 잠금 화면 시각 언어 | 본창과 같은 평면 (빛·그라디언트 제거, 색 토큰) | 앱의 첫 화면이 나머지와 다른 언어 |
| "비밀번호 저장" 문구 | "이 PC 에서 자동으로 잠금 해제" + 위험 보조 문구, 처음 설정 때 복구 불가 안내 | 뜻을 모르고 켜거나 끔 |
| 업데이트 뒤 안내 순서 | 복원 배너를 먼저 묻고, "업데이트 내용"은 그 뒤 (또는 상태 줄 버전에 점) | 모달과 배너가 동시에 경쟁 |
| 컨테이너 줄 버튼 밀도 | `로그`·`셸` 은 늘 보이고 나머지는 `⋯` 메뉴 | 큰 서버에서 버튼 수백 개 |
| DB 1,000행 상한과 추출 | 상한은 정책으로 두고 "전체 추출"은 별도 설계에서 판단 | 사용자가 추출도 1,000행에서 멈춘 줄 모름 (경고는 있음) |
| 밀도 설정(조밀/보통) | 토큰 도입(D6) 뒤에 판단 | 해당 없음 |

## NOT in scope (이번에 다루지 않은 것)

- 에이전트 채팅·작업 공간 패널·휴대폰 원격 접속 화면: claude-2 의 범위.
- 시안(mockup) 생성: 지금 있는 앱의 리뷰라 문서 지적과 화면 캡처로 대신했다. 시작 화면(D7)과 설정 구조(D8)는 구현 전에 `mockups/` 시안으로 확인하는 것을 권한다 (`/design-shotgun`).
- 브라우저 탭은 접근성과 토큰만 봤다 (큰 문제는 보이지 않음). `RemoteCompareView`, `OracleClientSetup`, `TreeFilterMenu` 는 깊게 보지 않았다.
- 원격 접속 설정의 켜진 상태(등록 기기, QR)는 캡처하지 못했다.

## What already exists (재사용할 것)

- 세션 색 네모 + 이름: `McpApprovalDialog.tsx` (서버 표지의 원형, D3).
- 대비 보정: `lib/pointerInk.ts` (탭 글자의 세션 색, 강조색 글자).
- 승인 무장 규칙: `lib/approvalArming.ts` (확인 창 공통).
- 확인 창: `ConfirmDialog` (OS `window.confirm` 대체).
- 대비 검사 테스트: `presets.test.ts` 의 companion 검사 (D10 에서 모든 프리셋으로 넓힘).
- 한국어 오류 변환: `lib/sftpRemoteDelete.ts`.
- 최근 접속 데이터: 명령 팔레트의 `history` (D7).
- 트리 키보드 이동: 세션 트리 (DB 트리·파일 탐색기에 같은 방식).

## Implementation Tasks

이 리뷰의 지적에서 나온 작업. 커밋·배정은 PL 이 정한다.

- [ ] **T1 (P1, human: ~3h / CC: ~30min)** — DB·서버 파일·SFTP — 서버 표지와 DB 배지 (D3)
  - Surfaced by: P1-1, P1-2
  - Files: `components/DbClient/DbClientView.tsx`, `DbClient.css`, `components/RemoteFile/RemoteFileDialogs.tsx`, `lib/sftpRemoteDelete.ts`, SFTP 머리, 새 공용 `ServerBadge`
  - Verify: SQL Server 가짜 info(`missingGuards`)로 경고색 배지, 저장·삭제 확인에 세션 이름·색이 보이는지. e2e `ssh-remote-file`, `ssh-sftp`
- [ ] **T2 (P1, human: ~3h / CC: ~30min)** — MCP 확인 창 — 위험도·명령 우선, 끝까지 봐야 허용, 머리·버튼 고정, 대기 건수, 남은 시간 색 (D4)
  - Surfaced by: P1-3
  - Files: `McpApprovalDialog.tsx`, `Mcp.css`, `modal-form.css`(그 창만), `src/mcp/approval.js`(대기 수 전달)
  - Verify: 긴 heredoc 명령에서 허용이 막혔다가 끝까지 내리면 풀림. 단위 테스트(`approvalArming`류)
- [ ] **T3 (P1, human: ~1h / CC: ~10min)** — 상태 줄 — 연결·끊김 수
  - Surfaced by: P1-4
  - Files: `components/Footer/Footer.tsx`, `footer.css`
  - Verify: 끊긴 탭이 있을 때 `N 연결 · M 끊김`
- [ ] **T4 (P1, human: ~2h / CC: ~20min)** — 업데이트 알림 — 오류 카드와 다시 시도
  - Surfaced by: P1-5
  - Files: `lib/updateCheck.ts`, `UpdateNotification.tsx`
  - Verify: `updateCheck.test.ts` 에 error 상태
- [ ] **T5 (P1, human: ~3h / CC: ~30min)** — 탭 줄 — 최대 폭·말줄임·가로 스크롤·`+` 고정·앞 탭 자동 스크롤 (D5)
  - Surfaced by: P1-6
  - Files: `terminal-tabs.css`, `App.tsx`(탭 줄), 분할 화면 탭 줄 `SplitPaneTabBar`
  - Verify: 1280px + 사이드바 + 작업 공간에서 탭 10개. e2e `local-tab-groups`, `local-screen-split`
- [ ] **T6 (P1, human: ~2h / CC: ~20min)** — SFTP·탐색기 — 오류 표시와 한국어, 빈 폴더 안내
  - Surfaced by: P1-7
  - Files: `components/Terminal/FileExplorer.tsx`, `components/Sftp/SftpPanel.tsx`, `FileList.tsx`
  - Verify: 권한 없는 폴더(시험 서버). e2e `ssh-sftp`
- [ ] **T7 (P1, human: ~1h / CC: ~10min)** — 컨테이너 — 명령 넣기 버튼 이름·아이콘, 넣은 뒤 안내와 터미널 포커스
  - Surfaced by: P1-8
  - Files: `components/Terminal/ContainerPanel.tsx`
  - Verify: e2e `ssh-container-search`
- [ ] **T8 (P1, human: ~3h / CC: ~30min)** — Alt 끌기 — 실행 중인 셸이면 확인 (D9)
  - Surfaced by: P1-9
  - Files: `usePaneGesture.ts`, `SplitChrome.tsx`, 로컬은 `src/localShell.js` 의 자식 프로세스 조회, SSH 는 판단 방법 설계 필요
  - Verify: e2e `local-split`
- [x] **T9 (P1, human: ~2h / CC: ~20min)** — 테마 — 흐린 글자 4.5:1, 검사 테스트를 모든 프리셋에 (D10)
  - Surfaced by: P1-10
  - Files: `themes/presets.ts`, `lightPresets.ts`, `presets.test.ts`
  - Verify: `npx vitest run src/renderer/themes/presets.test.ts`
  - 완료 (2026-11-25, claude-4): `presets.test.ts` 의 `every preset theme` 가 모든 프리셋의 CSS 블록에서 본문·보조·흐림·링크 글자를 `bg-primary`·`bg-secondary`·`bg-tertiary` 위 4.5:1 로, 위계(본문 > 보조 > 흐림)를 면마다 검사하고, CSS 블록의 글자·면 색이 TS 정의와 같은지 본다. 바꾸기 전 24개 테마가 실패했다.
  - 조정 규칙: 색상·채도는 두고 HSL 명도만 면에서 멀어지는 쪽으로 옮겨, 가장 어두운(밝은) 면 위에서 4.6:1 이 되는 첫 값을 골랐다 (16진 반올림 여유). 4.5:1 을 이미 넘는 색은 두었다. 보조 글자는 흐린 글자보다 면마다 0.2 이상 높을 때까지, 본문 글자는 보조보다 낮던 두 테마(Tokyo Night Day, Ayu Light)만 1 이상 높을 때까지 옮겼다. 채팅 짝 테마와 macOS 는 원래 통과해서 바뀌지 않았다. 사용자 지정 테마는 대상이 아니다.
  - 전후 (대비는 세 면 중 가장 낮은 값):

    | 테마 | 글자 | 전 | 후 |
    |---|---|---|---|
    | minimal-light | 흐림 | `#6b717a` 4.12 | `#646972` 4.62 |
    | cyberpunk-neon | 흐림 | `#666699` 3.4 | `#7d7da8` 4.65 |
    | nature-zen | 흐림 | `#6b8f7f` 4.05 | `#769989` 4.62 |
    | sunset-warm | 흐림 | `#8a7068` 3.47 | `#9e857e` 4.61 |
    | ocean-deep | 흐림 | `#607890` 3.46 | `#768da3` 4.61 |
    | retro-terminal | 흐림 | `#008800` 4.1 | `#009200` 4.63 |
    | dracula | 흐림 | `#6272a4` 3.03 | `#8592b8` 4.61 |
    | nord | 흐림 | `#8892a8` 3.22 | `#a8b0c0` 4.62 |
    | solarized-dark | 흐림 | `#657b83` 2.92 | `#8a9da4` 4.61 |
    | solarized-dark | 링크 | `#2aa198` 4.12 | `#2caba1` 4.61 |
    | monokai-pro | 흐림 | `#727072` 2.16 | `#acabac` 4.63 |
    | tokyo-night | 흐림 | `#565f89` 2.35 | `#888fb4` 4.6 |
    | gruvbox-dark | 흐림 | `#928374` 3.16 | `#ada296` 4.63 |
    | gruvbox-dark | 링크 | `#83a598` 4.31 | `#8baa9e` 4.61 |
    | catppuccin-mocha | 흐림 | `#6c7086` 2.57 | `#989cac` 4.6 |
    | one-dark-pro | 흐림 | `#5c6370` 2.32 | `#8d95a2` 4.64 |
    | rose-pine | 흐림 | `#6e6a86` 3.2 | `#88859e` 4.63 |
    | solarized-light | 보조 | `#586e75` 4.39 | `#53676e` 4.85 |
    | solarized-light | 흐림 | `#93a1a1` 2.18 | `#5c6a6a` 4.6 |
    | solarized-light | 링크 | `#268bd2` 3 | `#1d6ca2` 4.61 |
    | github-light | 보조 | `#656d76` 4.63 | `#626a73` 4.84 |
    | github-light | 흐림 | `#8b949e` 2.71 | `#646d78` 4.63 |
    | ayu-mirage | 흐림 | `#707a8c` 3.41 | `#8891a0` 4.64 |
    | catppuccin-latte | 흐림 | `#6c6f85` 3.73 | `#5f6174` 4.6 |
    | catppuccin-latte | 링크 | `#1c5fe4` 4.17 | `#1a59d6` 4.61 |
    | gruvbox-light | 흐림 | `#7c6f64` 3.55 | `#685e54` 4.61 |
    | tokyo-night-day | 본문 | `#3459b4` 4.84 | `#2d4c9b` 5.97 |
    | tokyo-night-day | 흐림 | `#68709a` 3.58 | `#585f84` 4.62 |
    | tokyo-night-day | 링크 | `#2463b8` 4.4 | `#2360b3` 4.61 |
    | rose-pine-dawn | 흐림 | `#797593` 3.67 | `#696582` 4.63 |
    | one-light | 흐림 | `#696c77` 4.16 | `#636570` 4.6 |
    | one-light | 링크 | `#3868d3` 4.08 | `#2d5fcc` 4.61 |
    | ayu-light | 본문 | `#5c6166` 5.23 | `#51555a` 6.28 |
    | ayu-light | 흐림 | `#787b80` 3.55 | `#67696d` 4.6 |
    | ayu-light | 링크 | `#2a75aa` 4.16 | `#276e9f` 4.6 |

  - 화면 전후 캡처: `e2e/.out/contrast/index.html` (Monokai Pro, Solarized Light, Dracula, Minimal Light 의 시작 화면·사이드바와 설정, 커밋하지 않는 폴더). 바꾼 색을 문서에 인라인으로 옛 값으로 덮어 '전' 을 찍었다.
- [ ] **T10 (P2, human: ~1d / CC: ~1h)** — 디자인 시스템 — DESIGN.md 작성, 글자·간격·레이어 토큰, 공용 IconButton·Menu·StatusItem (D6). 기존 화면은 고칠 때마다 옮김
  - Surfaced by: 디자인 시스템 절
  - Files: 새 `DESIGN.md`, `styles/variables.css`, `components/ui/`
  - Verify: 새 토큰을 쓰는 화면부터 캡처 비교
- [ ] **T11 (P2, human: ~1d / CC: ~1.5h)** — 시작 화면·사이드바 빈 상태 — 최근 접속, 첫 실행 버튼 넷, 세션 로딩 표시 (D7)
  - Surfaced by: 본창 구조 P2, 흐름 2·4
  - Files: `WelcomeScreen.tsx`, `SessionList.tsx`, 시안 `mockups/welcome-*.html` 먼저
  - Verify: 세션 0개·있음 두 경우 캡처
- [ ] **T12 (P2, human: ~1.5d / CC: ~2h)** — 설정 — 왼쪽 세로 목록, 검색, 창 크기 맞춤, `initialTab` (D8)
  - Surfaced by: 설정 모달 P2
  - Files: `components/Settings/SettingsModal.tsx`, `settings.css`, `ThemeSettings.tsx`, `SessionBackup.tsx`, 시안 먼저
  - Verify: 설정의 모든 항목이 검색으로 찾아지는지. e2e `ui-settings`, `pointer-themes`
- [ ] **T13 (P2, human: ~3h / CC: ~30min)** — 접근성 묶음
  - 탭 tablist 와 방향키, 탭 글자 대비
  - 팔레트 포커스 가두기와 단축키를 스토어에서 읽기
  - 잠금 화면 label·alert
  - 연결 끊김 role 과 팔레트 `재연결`
  - DB 트리 방향키, 탐색기 키보드, DbConsole 의 status 정리
  - 영어 aria 바꾸기, `MotionConfig reducedMotion`
  - 고대비 미디어 쿼리 고치기
  - Surfaced by: 접근성 지적들
  - Files: 각 지적의 파일
  - Verify: 키보드만으로 탭 이동·재연결·DB 트리 탐색
- [ ] **T14 (P2, human: ~1h / CC: ~10min)** — 버그 — `McpAuditList` 의 `entries` 없는 응답 처리
  - Surfaced by: 서버 작업 화면 P2 (캡처 중 발견)
  - Files: `components/Mcp/McpAuditList.tsx:17`
  - Verify: 단위 테스트 또는 `success:false` 응답으로 화면 유지
- [ ] **T15 (P2, human: ~2h / CC: ~20min)** — 서버 작업 화면 정리
  - `sftp.css` 고정 색을 토큰으로
  - 충돌 창 위험 버튼
  - 셸 종료 카드(`kind:'exited'`)
  - MCP 활동 꺼짐 빈 상태
  - 설정 입력 오류를 칸 아래로, `window.confirm` 을 `ConfirmDialog` 로
  - Surfaced by: 각 P2
- [ ] **T16 (P3, human: ~2h / CC: ~20min)** — 다듬기
  - 제목줄에 작업·탭 이름
  - 우클릭 메뉴 단축키·위험 표시, `편의` 나누기
  - 놓기 불가 테두리, 중복 규칙 정리
  - 파일 영역 모서리·이름표 대비
  - 로그 강조 막대 모양
  - 말줄임표, `999px`·`#000` 정리
  - 잠금 화면 평면화(열린 결정에 따라)

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 0 | — | — |
| Design Review | `/plan-design-review` | UI/UX gaps | 1 | issues_open | score: 5.5/10 → 8/10 (결정대로 고친 뒤 목표), 8 decisions |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **VERDICT:** 디자인 리뷰 완료, 고칠 작업 16건 (P1 9건). 구현 전 eng review 필요 (eng review required).

**UNRESOLVED DECISIONS:**
- 상태 줄 연결 표시의 뜻 (권장: `N 연결 · M 끊김`)
- 사이드바 강조 기준 (권장: 지금 보는 세션 하나)
- 잠금 화면 시각 언어 (권장: 본창과 같은 평면)
- "비밀번호 저장" 문구와 복구 불가 안내 (권장: "이 PC 에서 자동으로 잠금 해제")
- 업데이트 뒤 안내 순서 (권장: 복원 배너 먼저)
- 컨테이너 줄 버튼 밀도 (권장: `⋯` 메뉴)
- DB 1,000행 상한과 전체 추출 (권장: 상한 유지, 별도 설계)
