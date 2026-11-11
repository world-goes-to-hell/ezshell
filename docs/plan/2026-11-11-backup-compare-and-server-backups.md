# 백업 좌우 비교와 서버 백업 파일 표시

- 날짜: 2026-11-11
- 구분: 중간 (서버 백업 읽기 IPC 는 이름 검증을 테스트로 먼저 고정)
- 상태: 진행 중

## 요청
1. 파일 편집 창의 백업을 IntelliJ 처럼 좌우로 비교하고, 바뀐 덩어리마다 화살표로 백업 내용을 가져온다.
2. 서버에 사람이 만든 백업 파일(`compose.yaml.bak_20261020_1516`, `portal.env.bak_20261012` 등)도 백업 목록에 보여 준다. 앱 백업과 아이콘으로 구분한다.

## 1. 좌우 비교
- `@codemirror/merge@6.12.3` 의 `MergeView`. 왼쪽 백업(읽기 전용), 오른쪽 현재 편집기 내용.
- `revertControls: 'a-to-b'`: 화살표(») 는 백업 → 현재 방향만. 백업은 고칠 수 없다.
- 오른쪽에서 생긴 변경(화살표, 직접 입력, 되돌리기)은 거래마다 같은 변경을 본 편집기에 보낸다. 본 편집기가 계속 기준이라 저장/닫기 확인/Ctrl+Z 가 그대로 동작한다. 비교 화면을 닫을 때 따로 반영할 것이 없다.
- 비교 화면을 띄울 때 백업은 `toEditorText` 로 줄바꿈을 맞춘다 (CRLF 백업이 모든 줄 바뀜으로 보이지 않게).
- 상단: 백업 선택 상자, ◀ ▶, 변경 수, "같은 줄 접기"(기본 켬, `collapseUnchanged`), 비교 닫기. 백업을 바꾸면 MergeView 를 새로 만든다.
- 비교 계산 제한: `diffConfig` 의 시간 제한을 둔다 (본 편집기 저장 검토와 같은 300ms 기준).
- 파일: `RemoteCompareView.tsx`(새), `lib/backupCompare.ts`(백업 목록 합치기·이동 계산, 테스트), `RemoteCompare.css`(새), `RemoteTextEditView.tsx`, `RemoteBackupPanel.tsx`.
- 다른 세션이 `CodeEditor.tsx`, `RemoteFile.css` 를 고치는 중이라 이 두 파일은 건드리지 않는다.

## 2. 서버 백업 파일
- main `src/remoteFiles/serverBackups.js`(새):
  - `matchServerBackup(fileName, baseName)`: 이름이 `<원본 이름>` 뒤에 `.` `_` `-` `~` 로 이어지고, 나머지에 bak/backup/orig/old/save/prev/copy 가 있거나 날짜(`20YYMMDD`, `YYYY-MM-DD`)가 있으면 백업. `~` 하나로 끝나도 백업. `.sha256`, `.example`, `.swp` 는 아님.
  - 이름의 날짜·시각을 읽어 시각으로 쓰고, 없으면 파일 수정 시각.
  - `listServerBackups(sftp, realPath, requestedPath)`: 원본 파일의 실제 경로가 있는 폴더를 한 번 `readdir`. 일반 파일만 (readdir 의 속성은 링크를 따라가지 않으므로 심볼릭 링크는 빠진다). 최대 50개, 최신순.
- `documents.js`: 목록을 문서 상태에 기억(`serverBackups`: 이름 → 경로). 읽기 요청은 **마지막 목록에 있는 이름만** 받는다 (창이 임의 경로를 읽게 하지 않음). 읽기는 `readTextPreview` 로 5MB 까지 전체 UTF-8 (넘으면 거부), 시스템 경로·특수 파일 거부. 읽은 실제 경로가 목록의 경로와 다르면 거부 (그 사이 링크로 바뀐 경우).
- IPC: `remote-file-server-backups`, `remote-file-read-server-backup` (기존 `own` 검사 그대로).
- 화면: 목록 하나에 시간순으로 섞되, 앱 백업은 PC 아이콘 + "앱", 서버 파일은 서버 아이콘 + 파일 이름. 시각이 수정 시각이면 표시.

## 테스트
- `serverBackups.test.js`: 이름 판정(맞는 예·아닌 예), 날짜 읽기, 목록 정렬·개수 제한·일반 파일만.
- `documents.test.js`: 목록에 없는 이름 거부, 목록 전에 읽기 거부, 실제 경로가 바뀌면 거부.
- `lib/backupCompare.test.ts`: 두 목록 합치기와 정렬, 이전/다음 계산.
- 화면은 타입 체크와 실제 앱 확인으로 대신.

## 진행
- [x] 패키지 추가 (`@codemirror/merge@6.12.3`, 파일 창 묶음에만 들어감)
- [x] 서버 백업 (main, 테스트 먼저: `serverBackups.test.js` 8개, `documents.test.js` 7개)
- [x] 백업 목록 합치기 (`backupCompare.test.ts` 5개)
- [x] 좌우 비교 화면
- [x] 타입 체크, 테스트(84개), 빌드
- [x] 기능 검토 1회 (치명·높음·중간 0건, 낮음 3건 반영: 비교 중인 백업이 목록에서 사라지면 최신 백업으로, 미러가 어긋나면 알리고 비교 닫기, 수정 시각 없는 서버)
- [ ] 실제 앱 확인
