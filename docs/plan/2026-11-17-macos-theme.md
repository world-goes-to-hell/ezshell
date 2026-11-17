# macOS 느낌의 테마

작성일: 2026-11-17
상태: 구현 완료 (2026-11-17). 본창·연결 창·설정은 화면으로 확인, 터미널·SFTP·DB·분리 창은 실제 앱에서 확인 필요
구분: 중간 (UI 기능, 보안 경계 아님)

## 목표

사용자가 준 화면(밝은 회색 바탕, 시스템 파랑, 둥근 모서리, 왼쪽 신호등 버튼, 가운데 제목)과 같은 느낌의 테마를 테마 목록에서 고를 수 있게 한다. 운영체제와 무관하게 Windows 에서도 고를 수 있는 "모양" 이고, macOS 실행 지원(`2026-11-17-macos-support.md`)과는 별개의 작업이다.

## 설계

### 1. 프리셋 두 개
- `macos-light`(macOS Light, light), `macos-dark`(macOS Dark, dark).
- 정의는 `themes/macosPresets.ts`, CSS 는 `styles/themes-macos.css` (기존 `lightPresets.ts` + `themes-light.css` 와 같은 구성). `presets.ts` 가 펼쳐 넣고, `presets.test.ts` 의 CSS 목록에 새 파일을 더한다.
- 색: 창 바탕 밝은 회색, 사이드바는 한 단계 어두운 회색, 입력칸·떠 있는 창은 흰색 계열. 어두운 쪽은 macOS 다크 모드의 회색 단계(#1e1e1e 계열).
- 강조색은 시스템 파랑 계열이되, 흰 글자와 4.5:1 이 나오는 값으로 정한다 (순정 `#007aff` 는 4.0:1 이라 기존 테마 규칙에 못 미친다. 구현 때 계산해서 가장 가까운 값을 쓴다).
- 터미널 색은 macOS 터미널 기본 프로필에 가까운 16색.

### 2. 모양 (이 테마에만)
- 둥근 모서리: 테마 블록에서 `--radius-sm/md/lg/xl/full` 을 5/7/10/12/999px 로 덮어쓴다. 모서리의 약 300곳이 이미 이 토큰을 쓰므로 컴포넌트 CSS 는 고치지 않는다. 구현 뒤 화면을 돌며 둥근 모서리와 맞지 않는 곳(안쪽 요소가 모서리 밖으로 삐져나오는 곳)만 손본다.
- 입력칸 포커스: 강조색의 부드러운 3px 테두리 (`--shadow-glow` 를 이 테마에서 넓은 반투명 고리로).
- 그림자: 떠 있는 창에 넓고 옅은 그림자.

### 3. 타이틀바
- macOS 테마일 때 `TitleBar` 와 `PopoutTitleBar` 가 창 버튼을 왼쪽의 신호등(빨강 닫기, 노랑 최소화, 초록 최대화)으로 그리고 제목을 가운데에 둔다. 설정 버튼은 오른쪽에 남는다.
- 포인터를 올리면 버튼 안에 기호(×, −, +)가 보인다. 창에 포커스가 없으면 회색.
- 판단은 테마 정의의 새 선택 필드 `chrome: 'mac'` 으로 하고, 루트에 `data-chrome="mac"` 을 붙여 CSS 로 배치를 바꾼다 (테마 id 를 컴포넌트에 적지 않는다).

## 하지 않는 것
- 반투명(비치는) 사이드바: Windows 에서는 창 생성 옵션을 바꿔야 하고 터미널 가독성에 영향이 있다.
- 글꼴 변경: Windows 에는 SF 글꼴이 없다. Pretendard 를 그대로 쓴다.
- 사용자 지정 테마의 모양 설정: 테마 편집기는 색만 다룬다. macOS 테마를 복사해 만든 사용자 테마는 각진 모서리가 된다.

## macOS 실행 지원 작업과 겹치는 부분
실제 macOS 에서는 운영체제가 신호등을 그리므로(`titleBarStyle: hiddenInset`), 그 작업에서 "플랫폼이 darwin 이면 직접 그린 신호등을 숨기고 왼쪽 여백만 둔다" 를 `data-chrome` 규칙에 맞춰 넣으면 된다. 이번 작업은 Windows 에서의 표시만 다룬다.

## 테스트·검증
- `presets.test.ts`: 새 프리셋 두 개가 기존 검사(CSS 블록과 핵심 색 일치, light 는 밝은 바탕)를 통과. macOS 블록이 `--radius-md` 를 0 이 아닌 값으로 둔다는 검사 하나 추가.
- 끝날 때 typecheck, 전체 테스트, build 1회. 실제 앱에서 본창·연결 창·설정·SFTP·DB 탭·분리 창을 밝은 쪽과 어두운 쪽으로 확인.

## 파일
- 새로: `themes/macosPresets.ts`, `styles/themes-macos.css`
- 수정: `themes/presets.ts`, `themes/presets.test.ts`, `types/theme.ts`(`chrome`), `stores/themeStore.ts`(`data-chrome`), `hooks/usePopoutTheme.ts`, `TitleBar.tsx`, `PopoutTitleBar.tsx`, 타이틀바 CSS, 스타일 import 위치, `release-notes`, `CLAUDE.md`

## 구현 중 더한 것
- 스크롤 막대: 트랙을 없애고 둥근 손잡이로 바꿨다 (칠해진 트랙이 둥근 연결 창의 모서리 밖으로 각지게 보였다).
- macOS 첫 실행 기본 테마: macOS 실행 지원 작업의 요청으로 `lib/defaultTheme.ts` 를 더했다 (저장된 선택이 없을 때만, 시스템 모양에 따라 macOS Light/Dark).
- `normalizeTheme` 은 `chrome` 을 버린다 (사용자 지정 테마는 색만).
