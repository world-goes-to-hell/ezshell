# 타입 에러 해소 및 저장소 정리 계획

- 작성일: 2026-09-28
- 기준 커밋: f29e23f
- 상태: Phase 1~4 완료, 코드 리뷰 통과 (CRITICAL/HIGH/MEDIUM 0건)
- 실제 버그 4건 발견: docs/fix/2026-09-28-bugs-found-by-typecheck.md

## 배경

`npm run typecheck` 실행 시 타입 에러 82건이 발생한다. Vite 빌드는 타입 검사를 하지 않으므로
앱은 동작하지만, 타입 검사가 사실상 꺼진 상태라 실제 버그가 묻힌다.
또한 React 전환 이전의 레거시 파일과 임시 파일이 루트에 남아 있다.

| 에러 코드 | 건수 | 원인 |
|---|---|---|
| TS2339 / TS2551 | 45 | `types/index.ts`의 `electronAPI` 선언에 preload가 노출한 API가 빠져 있음 |
| TS6133 / TS6196 | 27 | 미사용 import/변수 (`noUnusedLocals`) |
| TS2345 / TS2322 / TS2353 / TS2349 / TS2503 | 10 | 개별 타입 불일치 (실제 버그 가능성 있음) |

## 단계

### Phase 1. electronAPI 타입 선언 보강 (45건)
- [x] preload.js 전체 API와 `types/index.ts` 선언을 1:1로 맞춘다
  - 누락: 재연결 이벤트, 자동 잠금 해제, 분할 쉘, 포트 포워딩, 업데이트, 설정, `sshExecCommand`, `mergeTerminalToMain` 등
- [x] preload에 없는데 선언만 있는 API(`toggleFullscreen`) 처리 확인

### Phase 2. 개별 타입 불일치 (10건)
- [x] App.tsx: `addTerminal` 인자 타입, `connectTimeout` 설정 필드, framer-motion `onDragEnd` 이벤트 타입
- [x] SessionList.tsx: `JSX` 네임스페이스, 드래그 이벤트 타입
- [x] CommandPalette.tsx, ShortcutsPanel.tsx(variants), TerminalWindow.tsx(호출 불가 표현식)
- 각 건마다 런타임 동작이 바뀌는지 확인하고, 실제 버그면 docs/fix 에 기록한다

### Phase 3. 미사용 코드 정리 (27건)
- [x] 미사용 import/변수 제거. 의도적으로 남겨 둔 상태값(예: 검색 매치 카운트)은 기능 연결 여부 확인 후 판단

### Phase 4. 저장소 정리
- [x] 레거시 바닐라 버전 삭제: `src/renderer.js`, `src/styles.css`, `src/index.html`, `update_renderer.py`
- [x] 임시 파일 삭제: `electron.vite.config.*.mjs` 13개, `tmux-*.log`, `nu_`, `src/nu_`, 깨진 경로 폴더 `D:DEVWORKSPACEELECTRONmy-ssh-clientassets`
- [x] 루트의 구현 보고서 3개(`AUTO_UPDATE_IMPLEMENTATION.md` 등)를 `docs/`로 이동
- [x] README, CLAUDE.md 의 빌드/배포 설명을 현재 스크립트(`build:nsis`, `build:portable`, `release/`)에 맞게 갱신

## 범위 밖 (별도 계획)
- `globals.css`(5,292줄), `App.tsx`(1,166줄) 분할
- 테스트 도입

## 완료 기준
- [x] `npx tsc --noEmit` 에러 0건 (exit 0)
- [x] `npm run build` 성공
- [x] `npm run dev` 기동 시 렌더러 오류 없음
- [ ] 실제 SSH 서버 대상 연결/분할/SFTP/드래그 동작 확인 (사용자 확인 필요)

## 진행 메모
- Phase 1: preload 에 없던 `toggleFullscreen` 을 main/preload 에 구현 (타입 선언만 있었음)
- Phase 2: 개별 타입 에러 중 3건이 실제 버그였음 (연결 설정 누락, motion.div 드래그 핸들러, 병합 시 connected 누락)
- Phase 4: `dist/` 는 gitignore 대상 예전 산출물이라 이번 범위에서 삭제하지 않음
