# State Management (Zustand)

[공통 작업 규칙과 기능별 목록](../../CLAUDE.md)

- `terminalStore.ts`: 핵심 스토어. 터미널 생성/삭제, SSH 데이터 핸들러 등록/해제, 분할 관리
- `sshDataHandlers`: Map<sessionId, handler> - 터미널별 SSH 데이터 수신 핸들러
- `sshDataBuffers`: 핸들러 미등록 시 데이터 버퍼링 (언마운트/리마운트 전환 중 데이터 보존)
