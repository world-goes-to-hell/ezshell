# 새 탭(+) 버튼 메뉴: 현재 세션 복제 / 기존 세션 선택 / 새 세션

## 요구사항

탭바 오른쪽의 `+` 버튼을 누르면 새 연결 모달이 바로 뜨는 대신, 아래 세 가지를 고를 수 있어야 한다.

1. **현재 세션 복제**: 활성 탭과 같은 접속 정보로 새 탭을 하나 더 연다.
2. **기존 세션 선택**: 저장된 세션 목록에서 골라서 연다.
3. **새 세션**: 지금처럼 새 연결 모달(ConnectModal)을 연다.

## 현재 구조

- `App.tsx`의 `.new-tab-btn`이 `handleNewConnection`을 바로 호출한다.
- 터미널 정보(`TerminalInfo`)에는 host/username/title/color만 있고 접속 설정은 없다.
  따라서 퀵 커넥트(저장 안 한 연결)는 렌더러에서 복제할 방법이 없다.
- 탭 우클릭 메뉴의 "탭 복제"도 실제로는 새 연결 모달만 연다(미구현 상태).
- 분할 패인 탭바(`SplitPaneTabBar`)의 `+`에는 이미 저장 세션 드롭다운이 따로 있다.

## 설계

### 1. 접속 설정 보관

- `useSSH.connect` 성공 시 사용한 `SSHConnectConfig`를 `TerminalInfo.connectConfig`에 보관한다.
  메모리에만 있고 디스크로 저장되지 않는다(terminalStore는 persist 안 함).
- `lib/duplicateConnection.ts`에 `getDuplicateConfig(terminal)` 순수 함수를 두어 복제할 설정을 꺼낸다.
- 복제는 이 설정으로 `connect()`를 다시 호출한다. 저장 세션/퀵 커넥트/점프 호스트 구분 없이 동일하게 동작한다.
- 탭 우클릭 "탭 복제"도 같은 함수를 쓰도록 고친다.

### 2. + 버튼 드롭다운 (`NewTabMenu`)

- Radix DropdownMenu 사용(기존 `PathBookmarkButton`과 같은 패턴).
- 항목: 현재 세션 복제(활성 탭 이름 표시, 복제 불가 시 비활성) / 기존 세션 선택… / 새 세션…

### 3. 세션 선택 모달 (`SessionPickerModal`)

- Radix Dialog + 검색 입력(Fuse.js: 이름, host, username, 폴더 경로).
- 각 항목에 폴더 경로와 `user@host:port` 표시, 이미 연결 중인 세션은 표시.
- 키보드: ↑↓ 이동, Enter 연결, Esc 닫기. 클릭으로도 연결.
- 필터링 로직은 `lib/sessionPicker.ts` 순수 함수로 분리하고 단위 테스트한다.

## 작업 목록

- [x] `lib/duplicateConnection.ts` + 테스트
- [x] `lib/sessionPicker.ts` + 테스트
- [x] `TerminalInfo.connectConfig` 추가, `useSSH.connect`에서 보관
- [x] `NewTabMenu` 컴포넌트 + CSS
- [x] `SessionPickerModal` 컴포넌트 + CSS
- [x] `App.tsx` 연결(+ 버튼, 탭 복제 컨텍스트 메뉴)
- [x] 타입 체크, 테스트, 실행 확인

## 범위 밖

- 분할 패인 탭바의 `+` 드롭다운은 이번에 건드리지 않는다(요청 범위: 단일 모드 탭바).

## 진행 결과 (2026-09-29)

- 단위 테스트: 신규 18개 포함 전체 175개 통과, `npm run typecheck` 오류 0건.
- E2E(CDP + 임시 SSH 서버 127.0.0.1:2222): 13개 시나리오 통과.
  - + 클릭 시 모달 대신 메뉴 3개 표시, 복제 항목에 활성 탭 이름 표시
  - 현재 세션 복제 / 탭 우클릭 "탭 복제"로 탭 추가(모달 안 뜸)
  - 세션 선택 모달: 자동 포커스, 폴더 경로 표시, 검색 필터, 방향키 이동, Esc 닫기
  - 새 세션 → 기존 새 연결 모달
- 검증 중 발견: 전역 `.modal-content { width: fit-content }`가 모달 너비를 덮어써서
  `.modal-content.session-picker-modal`로 선택자 우선순위를 높였다.

## 코드 리뷰 반영 (2026-09-29)

- [HIGH] 탭을 창 밖으로 분리했다가 병합하면 `connectConfig`가 사라져 복제가 안 되던 문제
  - 분리할 때 `detachedConfigsRef`에 설정을 맡기고, 병합 리스너에서 되돌려 놓는다.
  - 개발 모드 StrictMode에서 리스너가 두 번 등록되므로 병합 시 지우지 않고 탭을 닫을 때 정리한다
    (docs/brain/2026-09-29-strictmode-duplicate-ipc-listeners.md).
  - E2E: 연결 → 분리 → 병합 → 복제 6단계 통과.
- [MEDIUM] 닫힌 세션 선택 모달이 터미널 상태 변경마다 리렌더링되던 문제
  - 모달이 열려 있을 때만 `terminals`를 구독하고, 닫혀 있으면 고정된 빈 Map을 반환한다.
- [LOW] `connectConfig`에 비밀번호가 메모리로 유지됨: terminalStore는 persist하지 않고 IPC로도 나가지 않아 그대로 둔다.
