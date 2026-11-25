# LockScreen Safe API Pattern

[공통 작업 규칙과 기능별 목록](../../CLAUDE.md)

`window.electronAPI` 함수 호출 전 `typeof` 체크로 graceful degradation.
앱 빌드 후 재시작 전 새 API가 없을 수 있음.
