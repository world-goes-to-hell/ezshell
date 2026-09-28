# SFTP 업로드/다운로드 버튼이 "파일을 먼저 선택하세요"만 표시

- 작성일: 2026-09-28
- 관련: `2026-09-28-sftp-download-path-and-remote-delete.md` (다운로드 경로 중복 수정)

## 증상
파일을 선택한 뒤 SFTP 툴바의 업로드/다운로드 버튼을 누르면 선택이 없다는 안내만 뜨고 전송이 시작되지 않는다.
우클릭 메뉴의 다운로드, 목록 간 드래그는 정상.

## 원인
`FileList` 의 `onBlur` 가 "목록 밖을 누르면 선택 해제" 기능으로 포커스가 목록을 벗어나면 선택을 지운다.
툴바 버튼은 포커스를 받는 `<button>` 이라서, 클릭하면 순서가 다음과 같다.

1. mousedown → 포커스가 버튼으로 이동 → 목록 `blur` → 스토어의 선택 비움
2. 재렌더링
3. click → `handleUpload`/`handleDownload` 가 빈 선택을 보고 안내 알림 후 종료

우클릭 메뉴는 목록 내부에 렌더링되어 `blur` 가 발생하지 않고, 드래그는 `dataTransfer` 로 이름을 넘기므로 영향이 없었다.
이전 수정에서 추가한 "선택 없음" 안내 알림이 이 현상을 사용자 실수처럼 보이게 만들었다.

## 수정
- `FileList.tsx`: `keepSelectionProps` (`data-sftp-keep-selection`) 를 내보내고, `handleBlur` 에서 포커스가 이 속성을 가진 영역 안으로 이동하면 선택을 유지한다.
- `SftpPanel.tsx` 의 `.sftp-actions`, `SftpWindow.tsx` 의 `.sftp-toolbar` 에 속성을 붙였다.

버튼에 `onMouseDown preventDefault` 를 거는 방법도 있지만 키보드(Tab)로 버튼에 이동할 때는 막지 못해서 `relatedTarget` 판별을 택했다.
다른 목록이나 패널 밖을 누르면 기존처럼 선택이 해제된다.

## 추가: 덮어쓰기 창에서 "이름 바꾸기" 선택 시 오류
**원인**: 앱 버그가 아니라 Windows 권한 문제. 로컬 경로가 `C:\` 드라이브 루트였다.
`C:\` 의 ACL 은 일반 사용자에게 하위 폴더 생성(`AD`)만 허용하고 새 파일 생성은 막는다.
이름 바꾸기는 `C:\AMTAG (1).BIN` 을 새로 만들므로 `EPERM: operation not permitted, open 'C:\AMTAG (1).BIN'` 로 실패하고,
기존 파일에는 수정 권한이 상속되어 있어 덮어쓰기는 성공한다. 같은 조작을 임시 폴더로 하면 `AMTAG (1).BIN` 이 정상 저장된다.

**문제였던 점**: 전송 큐가 오류를 15자에서 잘라 `EPERM: operatio...` 만 보여 줘서 이유를 알 수 없었다.

**수정** (`TransferQueue.tsx`, `globals.css`):
- 상태 라벨에 `EPERM` → "쓰기 권한 없음" 추가, 알 수 없는 오류는 잘린 원문 대신 "오류" 로 표시
- 오류 항목 아래에 전체 오류 문구를 줄바꿈해 표시(텍스트 선택 가능)
- 다운로드의 `EPERM`/`EACCES` 에는 "드라이브 루트 대신 문서나 다운로드 폴더를 선택" 안내를 함께 표시

## 검증
- `npx tsc --noEmit` exit 0
- 전송 큐 캡처: 오류 항목 아래에 `EPERM: operation not permitted, open 'C:\AMTAG (1).BIN'` 과 안내 문구가 모두 표시됨
- 실행 중인 앱에 CDP(9333)로 실제 마우스 입력:
  - 원격 `AMTAG.BIN` 클릭 → 다운로드 버튼 클릭 → 포커스는 버튼으로 이동했지만 선택 유지, 덮어쓰기 확인 창 표시(로컬에 같은 이름 존재)
  - 로컬 경로를 임시 폴더로 바꾼 뒤 같은 동작 → 1024바이트 파일 저장 확인, 이후 로컬 경로 `C:\` 로 복원
