# 업데이트 후 "업데이트 내용" 창

- 날짜: 2026-11-12
- 구분: 중간 (보안 경계 없음. 버전 비교·마크다운 변환 로직만 테스트)
- 상태: 진행 중

## 요청
자동 업데이트로 새 버전이 설치된 뒤 앱이 다시 열리면 이번에 바뀐 내용을 보여 주는 창을 띄운다.

## 설계 (사용자 승인)
- 내용: 저장소 `release-notes/<버전>.md`. 렌더러가 `import.meta.glob` 으로 빌드에 묶는다 (인터넷 불필요, 원격 HTML 을 그리지 않음). GitHub 릴리스 본문도 같은 파일(`gh release create --notes-file`).
- 판단: main 의 `src/lastVersion.js` 가 `userData/last-version.json` 에 마지막으로 "본" 버전을 둔다.
  - 기록보다 지금 버전이 높으면 (기록, 지금] 사이 노트를 최신순으로 (최대 10개).
  - 기록이 없으면: 세션 파일(`sessions.json`)이나 `master.json` 이 있으면 기존 사용자 → 지금 버전 노트만. 없으면 새 설치 → 띄우지 않고 지금 버전을 기록.
  - 창의 `확인` 을 눌러야 기록 (`whats-new-seen`). 보기 전에 꺼지면 다음 실행에 다시.
- 화면: 잠금 해제 뒤 본창 대화상자 `WhatsNewDialog.tsx`. 마크다운은 `lib/releaseNotes.ts` 가 블록(제목·목록·문단)과 인라인(`코드`, **굵게**)으로 나누고 React 요소로 그린다 (innerHTML 없음). 명령 팔레트 `업데이트 내용 보기` 로 다시 연다.
- 누락 방지: `package.json` 버전의 노트 파일이 없으면 실패하는 테스트.
- 새 `src/lastVersion.js` 는 `MAIN_RUNTIME_MODULES` 에 추가.

## 진행
- [x] `releaseNotes.test.ts`(11개) → `releaseNotes.ts`, `lastVersion.test.js`(3개) → `lastVersion.js`
- [x] main IPC, preload, 대화상자, App 연결, 명령 팔레트
- [x] `release-notes/2.12.0.md`, `2.13.0.md`, `2.14.0.md` (GitHub 릴리스 본문)
- [x] 타입 체크, 테스트(전체 2,191개), 빌드, CLAUDE.md
- [ ] 실제 앱 확인 (다음 버전으로 업데이트된 뒤)
