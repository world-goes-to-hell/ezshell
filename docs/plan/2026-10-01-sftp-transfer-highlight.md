# SFTP 목록에서 업로드/다운로드한 파일 강조

## 요구 사항 (사용자 결정 2026-10-01)
- 유지 기간: 세션 동안 유지. 전송 큐에서 "완료 항목 지우기"를 누르면 해제된다.
- 표시 방식: 행 배경색 + 파일명 옆 방향 아이콘 (↑ 업로드는 원격 목록, ↓ 다운로드는 로컬 목록)
- 표시 대상: 전송 중(대기/일시정지 포함) + 완료 + 실패

## 확인한 사실
- 전송 큐는 메인 프로세스 `TransferQueue` 에 있고, 렌더러는 `sftp-queue-update` 로 받아 `sftpStore.transfers` 에 둔다.
- `emitQueueUpdate` 는 `fileName`(원본 이름)만 보내고 경로를 보내지 않는다. 이름 바꾸기 전송은 대상 이름이 다르므로 대상 경로가 필요하다.
- 전송 완료 후 목록을 다시 읽지 않는다. 새로 올린 파일은 수동 새로고침 전까지 목록에 없다.
- `sftp-queue-update` 는 `mainWindow` 로만 보낸다. 별도 SFTP 창에는 전송 큐 갱신이 가지 않는다 (기존 문제). → 사용자 요청으로 6번에서 지원

## 설계
1. `main.js` `emitQueueUpdate`: `localPath`, `remotePath` 를 함께 보낸다. (업로드 대상 = remotePath, 다운로드 대상 = localPath)
2. `lib/transferMarks.ts` (순수 함수, 단위 테스트)
   - `transferMarksFor(transfers, side, dirPath)` → `Map<파일명, { direction, state }>`
     - side 의 대상 경로가 `dirPath` 바로 아래인 전송만. Windows 경로는 대소문자/구분자 무시
     - state: queued/paused/active → `transferring`, completed → `done`, error → `error`
     - 같은 이름이 여러 번 전송되면 마지막 전송 기준
   - `finishedInto(prev, next, side, dirPath)` → 이번 갱신에서 그 폴더로 끝난(완료/실패) 전송이 있는지
3. `FileList.tsx`: 스토어의 transfers 로 marks 계산, 행에 `transfer-<direction> transfer-<state>` 클래스와 아이콘, 툴팁("업로드됨", "업로드 중", "업로드 실패: 사유")
4. `FileList.css`: 배경색(업로드/다운로드는 accent 계열, 실패는 error 계열), 왼쪽 강조 막대, 전송 중 아이콘 깜빡임(reduced-motion 시 정지). 선택/포커스 스타일이 우선하도록 순서 조정
5. `SftpPanel.tsx`, `SftpWindow.tsx`: 화면의 폴더로 전송이 끝나면 그 쪽 목록을 다시 읽는다 (여러 개가 연달아 끝나면 묶어서 한 번)

## 진행 상황
- [x] 1. main.js 경로 전달
- [x] 2. transferMarks + 테스트 (9개)
- [x] 3~4. FileList 표시 (`TransferMarkBadge.tsx` 로 배지/툴팁 분리)
- [x] 5. 완료 시 목록 새로고침 (`hooks/useReloadOnTransferActivity.ts`)
- [x] 타입 체크, 전체 테스트 288개 통과
- [x] 실제 앱 E2E 1차 (29개 항목 통과), 코드 리뷰 (CRITICAL/HIGH 없음)
- [x] 6. 별도 SFTP 창 지원: `sendToSftpViews` 로 메인 창 + 세션 SFTP 창에 큐 갱신 전송, `snapshot()` 공용화, 창이 열릴 때 `sftpGetQueue` 로 기존 큐 로드
- [x] 리뷰 반영: 로딩 중이면 자동 새로고침을 재시도 (`isBusy`)
- [x] E2E 결함 1: 행 클래스 `transfer-error` 가 전송 큐의 전역 `.transfer-error` 와 충돌해 실패 행의 열이 밀림 → `transfer-mark--*` 로 변경
- [x] E2E 결함 2: 서버가 WRITE 를 거부해도 업로드가 완료로 기록됨 (ssh2 쓰기 스트림이 error 없이 close 만 보냄) → close 후 원격 크기 검증 (`src/sftpUploadCheck.js`, `electron.vite.config.ts` 의 MAIN_RUNTIME_MODULES 에 추가)
- [x] 2차 E2E (별도 창 21개, 회귀 35개 항목 통과)
- [x] 7. 전송 중 표시를 초록 진행률 도넛으로 (사용자 승인)
  - 상태 분리: queued(빈 고리) / transferring(초록 원호) / paused(회색 원호) / done·error(화살표)
  - `role="progressbar"` + `aria-valuenow`, 툴팁 "업로드 중 42%"
  - 진행률은 0.5초 간격이라 `stroke-dashoffset` 에 0.5초 linear 전환, reduced-motion 이면 끔
  - 전송 시작(active) 시에도 목록 새로고침 → 새 파일 행이 바로 나타남 (`startedInto`, 훅 이름 `useReloadOnTransferActivity`)
  - 색 대비: 테마 20개 중 18개가 --success 3:1 이상. solarized-light 2.97, rose-pine 은 --success 가 청록 (테마 색을 따름)
- [ ] 3차 E2E (도넛)

## 구현 중 메모
- `useSftpStore(state => state.transfers(id))` 처럼 선택자로 구독하면 안 된다. 세션 상태가 아직 없을 때 `getSessionState` 가 매번 새 기본 객체를 돌려줘서 zustand v5 에서 무한 렌더가 난다. 기존 코드처럼 `useSftpStore().transfers(id)` 로 쓴다.
