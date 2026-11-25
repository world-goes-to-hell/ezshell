# Windows 재시작·강제 종료 뒤에도 탭과 Codex 역할을 되살리기 (2026-11-25)

## 1. 겪은 일 (2026-11-25 오전)

- 10:12:32 Windows 잠금. 잠기는 순간 얼굴 인식 센서 구성이 실패했고(Biometrics 1109, `0x80004005`), 10:27:01 Windows Hello 로그인이 `0xC0000234` 로 실패했다. 10:27:31 잠금 화면에서 다시 시작, 종료가 보안 프로그램(Fasoo DRM 등)에 붙잡힌 뒤 비정상 종료(Kernel-Power 41). ezShell 과 관련된 기록은 없다.
- 다시 켠 뒤 ezShell 의 탭 복원이 뜨지 않았다: `restore-tabs.json` 이 없었다.
- Codex 셋(개발B·C·D)의 역할이 사라졌다: `agent-roles.json` 에는 Claude 대화 둘만 있었다.

## 2. 원인

- 탭: `src/ipc/restoreTabs.js` 는 `app` 의 `before-quit` 와 창의 `close` 에서만 기록한다. Electron 문서: Windows 재시작·종료·로그오프에서는 `before-quit` 가 오지 않는다 (`electron.d.ts`). 창의 `query-session-end`·`session-end` 는 받지 않고 있었다. 그리고 강제 종료·전원 차단에는 어떤 신호도 오지 않는다.
- Codex 역할: 역할은 확인된 대화 키(`종류:UUID`)에만 저장한다. 새로 띄운 Codex 는 `codex resume <id>` 가 아니면 키를 확정하지 않아 역할이 메모리에만 있었다 (CLAUDE.md MCP Server 절의 역할 규칙). 사용량 감시기의 추정 UUID 와 훅의 세션 id 는 각각 따로는 믿지 않기로 했었다.

## 3. 고치는 것

### A. 탭 기록을 사용 중에 갱신 (codex-3)

- 화면이 탭 배치가 바뀔 때마다(몇 초 모아) 지금의 복원 기록을 main 에 보내고, main 이 마스터 비밀번호로 암호화해 `restore-tabs.json` 에 바뀐 경우만 쓴다 (임시 파일 후 이름 바꾸기). 강제 종료·전원 차단 뒤에도 마지막 상태가 남는다.
- 창의 `query-session-end`·`session-end`(Windows)에서 아직 쓰지 않은 최신 기록을 바로 쓴다 (화면 왕복 없이).
- 지키는 것: 기록 내용·암호화·읽으면 지우기는 지금과 같다 (비밀번호·화면 내용 없음). 업데이트 설치 기록(`source: 'update'`)을 덮어쓰지 않는다. 잠긴 동안은 잠그기 직전 기록을 유지한다.

### B. 새 Codex 의 대화 키 확정 (codex-4, 보안 검토 codex-5)

- 두 신호가 같을 때만 확정한다: 그 셸 토큰으로 검증된 Codex 훅의 세션 id, 그리고 사용량 감시기가 그 Codex 시작 뒤 같은 폴더에서 하나만 찾은 기록 파일의 UUID (후보가 둘 이상이면 확정하지 않음). 확정되면 기존 경로대로 메모리에 있던 역할을 저장한다.
- 용도는 역할 저장 키뿐이다 (재개 근거로 넓히지 않는다).

### C. 지금 떠 있는 Codex 의 역할 되살리기

- codex-3·4·5 에게 이전 대화에서 받은 역할을 `set_role` 로 다시 붙이게 한다.

## 4. 진행

- [x] A 탭 기록 갱신 (codex-3, 강제 종료 뒤 같은 프로필에서 두 탭 복원 확인)
- [x] B Codex 대화 키 확정 (codex-4)
- [x] B 보안 검토 (codex-5): 1차 중간 2·낮음 2 → codex-4 반영 → 재검토 통과
- [x] C 역할 되살리기: codex-5 → 개발B, codex-4 → 개발C, codex-3 → 개발D 복원
