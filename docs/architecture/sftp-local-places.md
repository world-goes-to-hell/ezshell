# SFTP Local Path Bar (바로 가기·드라이브)

[공통 작업 규칙과 기능별 목록](../../CLAUDE.md)

SFTP 패널의 로컬 주소줄을 누르면 즐겨찾기 → 바로 가기(바탕 화면·홈·문서·다운로드·사진·음악·동영상, 있는 폴더만) → 내 PC(드라이브) 목록이 펼쳐진다 (`PathBar.tsx`, 목록 계산 `lib/pathSuggestions.ts`). main 의 `src/localPlaces.js` 가 `app.getPath` 와 드라이브를 알려 주고(IPC `local-places`, 인자 없음, 30초 기억), Windows 드라이브 이름은 PowerShell `Win32_LogicalDisk` 를 UTF-8 출력으로 읽는다 (실패하면 A:~Z: 중 열리는 것만). 드라이브 선택 상자도 이 실제 드라이브를 쓴다. 새 `src/*.js` 라서 `MAIN_RUNTIME_MODULES` 에 있다. 바꾸면 안 되는 것: `local-places` 는 창에서 경로를 받지 않는다 (정해진 위치만 돌려준다). 설계: `docs/plan/2026-11-13-local-path-places.md`.
