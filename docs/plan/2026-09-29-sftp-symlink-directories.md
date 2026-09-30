# 사이드 SFTP 패널(FileExplorer): 심볼릭 링크 디렉토리 구분 표시

## 요구사항

터미널 옆 사이드 SFTP 패널에서 심볼릭 링크로 걸린 디렉토리를 일반 디렉토리와 다르게 표시한다.

## 현재 상태 (조사 결과)

- `main.js`의 `sftp-list`는 `sftp.readdir` 결과의 `attrs`로 `isDirectory`를 만든다.
  `readdir`의 attrs는 링크를 따라가지 않은(lstat) 값이라서, 디렉토리를 가리키는 링크도 `isDirectory: false`다.
- 따라서 지금 사이드 패널은 링크 디렉토리를 **파일 아이콘으로 보여 주고 펼칠 수도 없다**.
- 앱 전체에 심볼릭 링크 처리 코드가 없다.
- `sftp-delete`는 `isDirectory`가 true면 `rmdir`을 호출한다. `isDirectory`를 링크 대상 기준으로 바꾸면
  하단 SFTP 패널에서 링크를 삭제할 때 `rmdir`이 호출되어 실패하거나 의도와 다르게 동작할 수 있다.

## 설계

### 1. main: 링크 정보를 별도 필드로 추가 (`isDirectory`는 그대로)

`sftp-list` 응답 항목에 필드를 추가한다.

| 필드 | 의미 |
|------|------|
| `isSymlink` | 항목 자체가 심볼릭 링크인지 (`attrs.isSymbolicLink()`) |
| `linkTarget` | `readlink` 결과 (실패 시 없음) |
| `targetIsDirectory` | `stat`(링크를 따라감) 결과가 디렉토리인지 |
| `isBrokenLink` | 대상이 없어 `stat`이 실패한 링크 |

- 링크 항목에 대해서만 `stat`/`readlink`를 보낸다. 링크가 많은 디렉토리(`/lib` 등)를 고려해 동시 요청 수를 제한한다.
- 링크 해석 로직은 `src/sftpSymlinks.js`로 분리하고, sftp 함수를 주입받아 단위 테스트한다.
- 링크 해석이 실패해도 목록 자체는 실패시키지 않는다.

### 2. FileExplorer 표시

- 디렉토리 링크: 디렉토리처럼 펼칠 수 있고 디렉토리 그룹에 정렬된다.
  아이콘은 테두리만 있는 폴더 + 오른쪽 아래 링크 배지로 구분하고, 이름은 기울임꼴로 표시한다.
  이름 뒤에 `→ 대상 경로`를 흐리게 표시하고, 툴팁에도 대상 경로를 넣는다.
- 파일 링크: 파일 아이콘에 링크 표시.
- 깨진 링크: 흐린 색 + 빨간 끊어진 링크 배지, 툴팁에 "(깨진 링크)", 펼치지 않는다.

## 작업 목록

- [x] `src/sftpSymlinks.js` + 테스트
- [x] `main.js` `sftp-list`에 링크 필드 추가
- [x] 렌더러 입력 타입: `sftpList`는 기존대로 `Promise<any>`로 두고, 사이드 패널이 쓰는 필드만 `lib/fileExplorerNodes.ts`의 `RemoteListEntry`로 정의
- [x] `FileExplorer.tsx` 표시/펼치기/정렬 + CSS
- [x] 타입 체크, 테스트, 임시 SFTP 서버(링크 포함)로 실제 화면 확인

## 범위 밖

- 하단 SFTP 패널(`SftpPanel`/`FileList`)의 표시와 동작은 이번에 바꾸지 않는다. 새 필드는 받지만 사용하지 않는다.

## 진행 결과 (2026-09-29)

- 단위 테스트: 신규 17개(sftpSymlinks 10, fileExplorerNodes 7) 포함 전체 205개 통과, 타입 체크 오류 0건.
- E2E(임시 SFTP 서버에 junction/심볼릭 링크 생성, CDP DOM 검사): 9개 항목 통과.
  - 순서: link-dir, real-dir, broken-link, link.txt, real.txt (디렉토리 링크가 디렉토리 그룹에 정렬)
  - 링크 디렉토리: 링크 배지, 기울임꼴, "→ /real-dir", 툴팁 "/link-dir → /real-dir", 펼치면 대상 내용(sub) 표시
  - 일반 디렉토리: 표시 변화 없음
  - 깨진 링크: 구분 표시, 펼침 불가 / 파일 링크: 배지 표시
- 창이 다른 창에 가려진 상태라 스크린샷은 찍지 못했다(아래 brain 기록 참고).
- `main.js`가 바뀌었으므로 이미 실행 중인 개발 앱은 재시작해야 반영된다.

## 코드 리뷰 반영 (2026-09-29)

- [MEDIUM] 깨진 링크 배지가 빨간색으로 보이지 않던 문제: `... .file-explorer-link-icon svg` 선택자의 명시도가 배지 규칙보다 높았다.
  `svg:not(.file-explorer-link-badge)`로 좁혀서 해결. E2E에서 계산된 색상(--error / --text-muted / --accent)으로 확인.
- [MEDIUM] 링크 해석 요청에 타임아웃이 없어, 서버가 한 요청에 응답하지 않으면 목록 전체가 로딩 상태로 멈출 수 있던 문제:
  요청마다 5초 제한을 두고, 시간 초과된 링크는 "대상 미확인"(펼침 불가, 깨진 링크 표시 없음)으로 반환한다. 단위 테스트 추가.
- 최종: 테스트 206개 통과, 타입 체크 오류 0건, E2E 12개 항목 통과.
