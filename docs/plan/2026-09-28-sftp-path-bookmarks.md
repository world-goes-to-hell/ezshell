# SFTP 경로 즐겨찾기

- 작성일: 2026-09-28
- 상태: 구현 완료, 앱 재시작 후 동작 확인 필요 (main/preload 변경은 dev 모드에서도 재시작해야 반영)

## 요구사항 (사용자 결정 반영)
- SFTP 패널의 경로 입력창 옆에 즐겨찾기 버튼, 등록한 경로를 바로 선택
- 로컬 / 원격 경로 모두, 목록은 각각 따로
- 저장 단위: **사이드바에 저장된 세션 항목별** (savedSessionId)
  - 저장하지 않은 빠른 연결은 즐겨찾기 비활성 (버튼 disabled + 안내 툴팁)

## 설계
| 항목 | 결정 | 이유 |
|---|---|---|
| 세션 식별 | 연결 설정에 `savedSessionId` 를 실어 main 의 `connectionStates.config` 에 보관, `ssh-get-session-info` IPC 로 조회 | 런타임 sessionId 는 연결마다 바뀜. 분리된 SFTP 창에서도 조회 가능해야 함 |
| 저장소 | main 의 `userData/path-bookmarks.json` `{ [savedSessionId]: { local: string[], remote: string[] } }` | 메인 창과 분리 창이 동시에 써도 main 한 곳에서 읽고 쓰므로 덮어쓰기 경쟁 없음 |
| 동기화 | 저장 시 모든 창에 `path-bookmarks-changed` 브로드캐스트 | 다른 창의 목록도 즉시 갱신 |
| UI | 경로 옆 별 버튼(등록 경로면 채워진 별) → 드롭다운: 현재 경로 추가/제거, 목록(클릭 이동, x 삭제) | 입력창 흐름을 바꾸지 않고 한 번 클릭으로 이동 |

## 작업
- [x] main: `ssh-get-session-info`, `path-bookmarks-get`, `path-bookmarks-set` IPC + 변경 브로드캐스트
- [x] preload / types: API 노출과 타입 선언
- [x] 연결 경로에서 `savedSessionId` 전달 (`toSSHConnectConfig`, 새 세션 저장 시 생성한 id 포함)
- [x] `hooks/usePathBookmarks.ts`: 조회/추가/삭제/변경 구독
- [x] `PathBookmarkButton` 컴포넌트 + CSS (각진 스타일, 최소 크기 기준 준수)
- [x] `PathBar` 에 버튼 배치, `SftpPanel` / `SftpWindow` 에서 sessionId 전달
- [x] 검증: tsc, build, main/preload 문법 검사
- [ ] 앱 재시작 후 실제 등록/이동/삭제, 분리 창 동기화 확인

## 범위 밖
- 저장된 세션 삭제 시 해당 즐겨찾기 정리 (남아도 동작에 영향 없음)
- 즐겨찾기 이름 붙이기 / 순서 변경

## 함께 처리한 요청: 접힌 사이드바 세션 툴팁
- 원인: 기존 CSS `::after` 툴팁이 사이드바 밖으로 그려지는데 세션 목록이 `overflow-y: auto` 라 잘려서 보이지 않았음. 내용도 이름뿐.
- 조치: `components/Sidebar/SessionTooltip.tsx` (Radix Tooltip, 포털 렌더링) 로 교체.
  표시 내용: 세션명, 사용자@호스트(:포트), 폴더, 연결 상태, 태그, "더블클릭으로 연결" 안내.
- 기존 `data-tooltip` 속성과 잘리던 CSS 규칙 삭제.

## 진행 중 사고
- 새 Radix 패키지를 처음 import 하면서 Vite 재최적화로 dev 앱이 두 번 새로 고침되어 사용자 터미널 탭이 사라짐.
- main/preload 미반영 상태에서 새 API 호출로 렌더러가 한 번 멈춤 → Safe API 패턴으로 수정.
- 기록: docs/brain/2026-09-28-dev-mode-edits-kill-live-terminal-sessions.md

## 함께 처리한 요청: 터미널 드래그 시 자동 복사 + 알림
- `lib/terminalClipboard.ts`: `enableCopyOnSelect(term)` 은 mouseup 시점에 선택이 있으면 한 번만 복사하고 "복사됨" 알림(2초)을 띄운다.
  onSelectionChange 는 드래그 중 계속 발생하므로 쓰지 않는다. 같은 선택을 다시 클릭해도 중복 복사하지 않는다.
- 메인/분할/분리 터미널 세 곳에 연결, Ctrl+C 복사도 같은 알림 사용.
- 분리된 터미널/SFTP 창에는 ToastContainer 가 없어 알림이 보이지 않던 문제도 함께 수정.

## 재시작 후 확인
- [x] 새 API 노출 확인, 없는 키 조회 시 빈 목록, `__proto__` 키 거부 확인 (CDP)

## 추가 기능: 세션 복제
- 사이드바 세션 우클릭 메뉴에 "복제" 추가 (수정 아래)
- 누르면 새 연결 창(제목 "세션 복제")이 원본 설정으로 채워져 열리고, 이름은 "원본 이름 - 복제됨"
- 원본 id 는 비워서 저장 시 항상 새 세션으로 등록 (원본 덮어쓰기 없음). "저장"(등록만) / "연결" 버튼 제공
- 파일: SessionList.tsx, Sidebar.tsx, ConnectModal.tsx(duplicateFrom prop), App.tsx(handleDuplicateSession)
- 검증: tsc, build, 실행 중 앱에 새로 고침 없이 반영(uptime 유지, 오류 로그 없음)
