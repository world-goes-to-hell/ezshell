# SFTP 로컬 주소줄 바로 가기 목록

- 날짜: 2026-11-13
- 구분: 중간 (새 IPC 하나, 인자 없음)
- 상태: 진행 중

## 요청
SFTP 패널의 로컬(PC) 주소줄을 누르면 Windows 탐색기처럼 바탕 화면, 내 PC 의 드라이브, 자주 쓰는 폴더가 펼쳐진다.

## 설계 (사용자 승인)
- main `src/localPlaces.js`: 바로 가기(바탕 화면·홈·문서·다운로드·사진·음악·동영상, `app.getPath`, 있는 폴더만)와 드라이브.
  - Windows 드라이브: PowerShell `Win32_LogicalDisk` 한 번(4초 제한) → 이름(볼륨 이름, 없으면 종류: 로컬 디스크·이동식 디스크·네트워크 드라이브·CD 드라이브). 30초 기억. 실패하면 A:~Z: 중 열리는 것만 이름 없이.
  - macOS·Linux: `/` 와 `/Volumes/*`, `/mnt/*`, `/media/<사용자>/*`.
- IPC `local-places`: 인자 없음. 정해진 경로만 돌려준다.
- 화면: 로컬 주소줄 편집 중 목록 = 즐겨찾기 → 바로 가기 → 내 PC(드라이브). 입력하면 거름. 기존 드라이브 선택 상자도 실제 드라이브를 쓴다(C:~H: 고정 제거).
- 파일: `src/localPlaces.js`(+테스트, `MAIN_RUNTIME_MODULES`), `main.js`, `preload.js`, 타입, `PathBar.tsx`, `PathBookmarkSuggestions.tsx`, `hooks/useLocalPlaces.ts`, CSS.

## 진행
- [x] `localPlaces.test.js`(8개) → `localPlaces.js` (이 PC 에서 실제로 읽어 봄: 로컬 디스크 (C:), 새 볼륨 (D:), WINDRIVER (X:))
- [x] IPC, 화면 (`pathSuggestions.test.ts` 4개)
- [x] 타입 검사, 테스트, 빌드, CLAUDE.md
- [ ] 실제 앱 화면 확인
