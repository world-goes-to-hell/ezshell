# 타입 에러 정리 중 발견한 런타임 버그 4건

- 작성일: 2026-09-28
- 관련 계획: docs/plan/2026-09-28-typecheck-and-cleanup.md

타입 검사(`tsc --noEmit`)가 82건의 에러로 사실상 꺼져 있던 탓에, 아래 버그들이 에러 목록에 묻혀 있었다.

## 1. 연결 설정(점프 호스트, 타임아웃, 자동 재연결)이 main 프로세스로 전달되지 않음

**증상**
- 점프 호스트를 설정한 세션도 항상 대상 서버에 직접 연결을 시도한다.
- 사용자가 지정한 연결 타임아웃과 keepalive 간격이 무시되고 기본값(20초, 30초)이 쓰인다.
- 자동 재연결을 꺼도 main 에서 `undefined !== false` 가 참이 되어 항상 켜진 채로 동작한다.

**원인**
`hooks/useSSH.ts` 의 `connect()` 가 `sshConnect` 에 host/port/username/인증 정보만 골라서 넘겼다.
App.tsx 는 연결 설정을 모두 넘기고 있었지만 훅의 파라미터 타입에 해당 필드가 없어 TS2353 이 났고,
런타임에서는 훅 내부에서 조용히 버려졌다. 분할 패인의 "+" 탭 추가 경로 2곳은 애초에 연결 설정을 넘기지 않았다.

**수정**
- `useSSH` 에 `SSHConnectConfig` 타입을 정의하고, UI 전용 필드(sessionName, color, postConnectScript)를 제외한 나머지를 모두 main 으로 전달한다.
- `lib/sshConnectConfig.ts` 의 `toSSHConnectConfig()` 로 저장된 세션을 연결 설정으로 변환하는 로직(초 → 밀리초 포함)을 한곳에 모았다.
  세 개의 연결 경로(`handleConnect`, primary/secondary 패인의 `onAddTab`)가 모두 이 함수를 사용한다.
- 호출처가 없던 `handleConnectFromDropdown` 은 삭제했다.

## 2. 메인 탭 드래그, 세션 → 폴더 드래그가 동작하지 않음

**증상**
메인 탭 바에서 탭을 끌어 분할하거나 창 밖으로 팝아웃하는 기능, 사이드바에서 세션을 폴더로 옮기는 기능이 동작하지 않는다.
(폴더 드래그와 분할 패인 탭 바의 드래그는 일반 `div` 라서 정상)

**원인**
두 요소 모두 `motion.div` 였다. framer-motion 은 `onDragStart` / `onDragEnd` 를 자체 드래그 제스처 prop 으로 취급해
DOM 으로 전달하지 않고(`motion/utils/valid-prop.mjs`), `drag` prop 이 켜졌을 때만 호출한다.
따라서 HTML5 네이티브 `dragstart` / `dragend` 핸들러가 한 번도 등록되지 않았다.

**수정**
React 표준 캡처 prop 인 `onDragStartCapture` / `onDragEndCapture` 로 바꿨다. framer-motion 이 가로채지 않는 이름이다.
- `App.tsx` 메인 탭
- `components/Sidebar/SessionList.tsx` 의 `SessionItem`

## 3. 팝아웃 터미널을 메인 창으로 병합하면 연결 끊김 상태로 표시됨

**원인**
`onTerminalMerge` 에서 `addTerminal` 에 `id` 와 `connected` 없이 등록했다. `connected` 가 `undefined` 라서
사이드바 활성 세션 표시(`activeSessionIds`) 등에서 끊긴 세션으로 취급됐다.

**수정**
`id: sessionId`, `connected: true` 로 등록한다. SSH 연결은 main 프로세스가 계속 유지하므로 병합 시점에도 살아 있다.

## 4. 전체 화면 전환 단축키 실행 시 TypeError

**원인**
단축키 액션이 `window.electronAPI.toggleFullscreen()` 을 호출하지만 preload 와 main 어디에도 구현이 없었다.
타입 선언에만 존재했다.

**수정**
main 에 `window-toggle-fullscreen` IPC 핸들러를 추가하고 preload 에 `toggleFullscreen` 을 노출했다.
