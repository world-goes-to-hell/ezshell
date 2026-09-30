# 사용자가 dev 모드 앱을 쓰는 중에 코드를 고치면 터미널 세션이 날아간다

## 증상
사용자가 `npm run dev` 로 띄운 앱을 실제로 쓰는 중(SSH 연결, SFTP 패널 열림)에 렌더러 코드를 고쳤더니
- 화면이 통째로 멈추거나(React 트리 언마운트)
- 페이지가 새로 고쳐져 터미널 탭이 모두 사라졌다.
SSH 연결은 main 프로세스에 남지만 렌더러와의 연결이 끊겨 사용자는 다시 접속해야 한다.

## 원인 세 가지
1. **처음 import 하는 패키지 → Vite 의존성 재최적화 → 강제 전체 새로 고침**
   로그: `new dependencies optimized: @radix-ui/react-dropdown-menu` / `optimized dependencies changed. reloading`
   package.json 에 있어도 한 번도 import 되지 않았던 패키지는 처음 쓰는 순간 이렇게 된다.
2. **main / preload 는 HMR 되지 않는다.** 렌더러만 새 코드를 받으므로 새 IPC API 를 호출하면
   `window.electronAPI.xxx is not a function` 이 난다. effect 안에서 try 밖으로 던지면 에러 바운더리가 없어 앱 전체가 언마운트된다.
3. 재최적화 직전 짧은 순간에는 React 사본이 둘로 갈려 `Cannot read properties of null (reading 'useState')` 도 찍힌다.

## 대응
- 사용자가 앱을 쓰는 중이면(터미널 탭 존재) 새 패키지 import, main/preload 변경은 **먼저 알리고** 반영 시점을 사용자에게 맡긴다.
- 새 preload API 는 호출 전에 `typeof api?.fn === 'function'` 으로 확인한다 (CLAUDE.md 의 LockScreen Safe API 패턴).
- 새 의존성을 쓰기 시작할 때는 `electron.vite.config.ts` 의 renderer `optimizeDeps.include` 에 미리 넣으면 재최적화 새로 고침을 피할 수 있다.

## 사례
2026-09-28 SFTP 경로 즐겨찾기(Radix DropdownMenu)와 접힌 사이드바 툴팁(Radix Tooltip) 추가 중 두 번 새로 고침되어 사용자 터미널 탭이 사라졌다.

## 추가 (2026-09-28): 스토어 파일 수정 시 사이드바가 빈 목록이 됨
`stores/sessionStore.ts` 를 개발 모드에서 수정하면 HMR 이 zustand 스토어를 초기 상태(세션 0개)로 다시 만든다.
`loadFromBackend` 는 앱 시작 때만 호출되므로 사이드바에 "저장된 연결이 없습니다" 가 뜬다.
**위험**: 이 상태에서 세션 수정/폴더 이동 등으로 `saveToBackend` 가 실행되면 빈 목록이 sessions.json 을 덮어쓴다.
**대응**: 스토어 파일을 고친 뒤에는 디스크의 sessions.json 개수를 확인하고, 화면을 새로 고쳐(Ctrl+R 또는 CDP `Page.reload`) 다시 불러온다.
