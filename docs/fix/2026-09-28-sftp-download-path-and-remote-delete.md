# SFTP 다운로드 항상 실패 / 원격 삭제 미구현 / 전송 버튼 무반응

- 작성일: 2026-09-28

## 1. 다운로드가 항상 실패 (ENOENT)
**원인**: 렌더러(`SftpPanel`, `SftpWindow`)는 `sftpQueueDownload` 에 저장할 **파일 전체 경로**를 넘기는데,
main 의 `executeDownload` 는 이를 폴더로 보고 `path.join(localPath, basename(remotePath))` 로 파일명을 한 번 더 붙였다.
→ `D:\...\app.env\app.env` 에 쓰려다 ENOENT. 다운로드 버튼, 원격→로컬 드래그, 덮어쓰기 "이름 바꾸기" 모두 같은 경로라 전부 실패.
(업로드는 받은 경로를 그대로 써서 정상)
**발견**: 실행 중 앱에서 `/etc/hostname` 을 임시 폴더로 받는 실제 다운로드 테스트의 오류 메시지.
**수정**: `executeDownload` 가 `transfer.localPath` 를 그대로 저장 경로로 사용 (업로드와 같은 규약).

## 2. 원격 파일 우클릭 "삭제" 가 아무 동작도 안 함
**원인**: `FileList.handleContextAction` 에 삭제 분기가 없고 `// Delete can be implemented later` 주석만 있었다. main 의 `sftp-delete` 는 구현돼 있었음.
**수정**:
- `lib/sftpRemoteDelete.ts`: 선택 항목 확인(이름 최대 5개 + 개수 표시) 후 순차 삭제, 성공/실패 요약 알림.
  폴더는 SFTP `rmdir` 규약대로 빈 폴더만 삭제되며, 실패 시 "비어 있지 않거나 권한 없음" 으로 안내.
- `FileList` 에 `onDelete` prop 추가, 원격 목록에만 전달. 로컬 삭제 기능은 없으므로 로컬 목록에서는 메뉴 항목을 숨김.

## 3. 업로드/다운로드 버튼을 눌러도 반응 없음
**원인**: 선택 항목이 없으면 조용히 `return`, 다운로드에서 폴더만 선택하면 조용히 무시.
**수정**: 각 경우 안내 알림 표시, 툴팁을 동작 설명("선택한 로컬 파일을 현재 원격 폴더로")으로 변경.
