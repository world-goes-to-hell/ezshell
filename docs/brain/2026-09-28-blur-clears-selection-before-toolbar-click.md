# 목록 blur 시 선택 해제 + 목록 밖 툴바 버튼 = 버튼이 항상 빈 선택을 본다

## 왜 바로 못 잡았나
- 다운로드 실패를 main 의 경로 중복(ENOENT)으로 먼저 고쳤고, 그 테스트는 IPC 를 직접 호출해서 선택 상태를 거치지 않았다.
- 버튼 무반응은 "사용자가 선택을 안 했다"고 보고 안내 알림만 추가했다. 실제로는 선택이 클릭 직전에 지워지고 있었다.
- `element.click()` 같은 합성 클릭은 포커스를 옮기지 않아 재현되지 않는다. CDP `Input.dispatchMouseEvent` 로 실제 mousedown 을 보내야 드러난다.

## 판별
- 선택을 소비하는 버튼이 선택 목록 바깥에 있고, 목록에 `onBlur` 선택 해제가 있으면 의심한다.
- 클릭 직후 `document.activeElement` 가 버튼이고 선택이 비어 있으면 이 문제다.

## 해결 패턴
`onBlur` 에서 `e.relatedTarget?.closest('[data-...-keep-selection]')` 이면 선택을 유지한다 (`FileList.keepSelectionProps`).
상세: docs/fix/2026-09-28-sftp-toolbar-selection-cleared-on-blur.md
