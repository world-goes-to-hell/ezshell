# SFTP 패널 Windows 탐색기 단축키

## 목표
SFTP 파일 목록(로컬/원격)에 포커스가 있을 때 Windows 탐색기와 같은 단축키를 쓸 수 있게 한다.

## 결정 사항 (2026-09-28 사용자 확인)
- 로컬 목록도 이름 바꾸기, 새 폴더, 삭제를 지원한다. 로컬 삭제는 Windows 휴지통으로 보낸다.
- Ctrl+C / Ctrl+V 는 이번 범위에서 제외한다.
- 파일 목록 위에서는 앱 전역 단축키 대신 탐색기 동작을 따른다: Ctrl+L = 경로 입력, Ctrl+F·Ctrl+W 는 무시.

## 단축키
| 키 | 동작 |
|---|---|
| F2 | 이름 바꾸기 (목록 안에서 편집, Enter 확정 / Esc 취소) |
| Delete | 삭제 (원격: 영구 삭제 확인, 로컬: 휴지통 이동 확인) |
| Ctrl+Shift+N | 새 폴더 |
| F5 | 새로고침 |
| Alt+← / Alt+→ | 뒤로 / 앞으로 (방문 기록) |
| Alt+↑ | 상위 폴더 |
| Home / End | 첫 항목 / 마지막 항목 |
| Esc | 선택 해제 |
| Ctrl+L | 경로 입력창으로 이동 |

## 주의할 점
- 이름 편집 입력창의 키 입력이 목록의 onKeyDown 까지 올라오지 않게 막는다 (Backspace → 상위 폴더, Ctrl+A → 전체 선택 방지).
- 처리한 키는 stopPropagation 해서 window 전역 단축키(앱 잠금, 탭 닫기, 터미널 검색, Esc 두 번 = Zen 모드)가 같이 실행되지 않게 한다.
- 로컬 이름 바꾸기는 fs.rename 이 Windows 에서 기존 파일을 덮어쓰므로, 대상이 이미 있으면 거부한다.
- 동기화 모드는 탐색만 맞추므로 이름 바꾸기/새 폴더는 반대쪽에 반영되지 않는다.

## 추가로 반영한 것
- 우클릭 메뉴: 파일/폴더에 이름 바꾸기(F2), 새 폴더, 삭제(로컬은 "휴지통으로 이동")를 단축키 표시와 함께 추가. 빈 공간 우클릭 시 새 폴더, 새로고침 메뉴 표시.
- 우클릭 메뉴가 Esc 로 닫히지 않던 기존 문제 수정.
- 클릭 시 이전 키보드 포커스(외곽선)를 지워서 F2/화살표가 클릭한 항목 기준으로 동작하도록 수정.

## 진행 상황
- [x] main: 로컬 이름 바꾸기/새 폴더/휴지통 IPC + 테스트 11건 (`src/localFileOps.js`)
- [x] 이름 검증, 단축키 매핑, 경로/폴더명 헬퍼 + 테스트 29건
- [x] FileList: 단축키, 인라인 이름 편집(`InlineNameInput`), 컨텍스트 메뉴(`FileListContextMenu`), 아이콘 분리(`fileIcons`)
- [x] SftpPanel / SftpWindow 연결(`useSftpPaneActions`), PathBar `editRequest`
- [x] `npm run typecheck` 오류 0건, `vitest run` 157 passed
- [x] 임시 SSH/SFTP 서버 + CDP 실제 입력으로 25개 시나리오 통과 (방법: docs/brain/2026-09-28-sftp-e2e-without-real-servers.md)
