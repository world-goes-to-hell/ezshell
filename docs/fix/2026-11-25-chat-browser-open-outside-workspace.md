# 채팅 링크 미리보기: 작업 폴더 밖 HTML 의 `브라우저로 열기` 가 거부됨

작성: 2026-11-25 (사용자 보고: 다른 세션의 임시 폴더(scratchpad)에 있는 `pane-divider.html` 미리보기에서 `브라우저로 열기` 를 누르면 "이 폴더는 작업 공간에서 열 수 없습니다 (열려 있는 로컬 터미널의 폴더나 그 Git 저장소만)" 이 떴다)

## 원인
채팅의 `브라우저로 열기` 는 HTML 이 상대 경로의 CSS·JS·그림을 읽을 수 있게 문서 루트를 정해 브라우저 탭으로 연다 (`browserReview.openWorkspace`). 파일이 에이전트 작업 폴더 안이면 그 폴더를, 밖이면 파일의 폴더를 루트로 넘기는데, 루트 검사는 작업 공간 파일 트리용(`localFiles/roots.js` 의 `resolveRoot`: 열린 로컬 셸의 폴더와 그 Git 저장소만)이었다. 그래서 작업 폴더 밖의 파일은 대화에 나온 링크인데도 언제나 거부되었다.

## 수정
- 채팅이 작업 폴더 밖의 링크를 열 때는 `linkFolder` 로 표시해 넘기고, 브라우저 탭은 그 폴더를 작업 공간 검사 대신 `resolveLinkFolder` 로 검사한다: 이 PC 의 드라이브 경로(UNC·장치 경로 거부, 링크는 한 조각씩 풀어 다시 검사)이고 폴더이며 드라이브 루트가 아니어야 한다. 링크 자체의 허가는 그대로 `knowsLink`·`linkAuthority` 가 본다.
- 파일의 폴더는 홈 폴더처럼 넓은 곳일 수 있다. 그 페이지의 스크립트가 같은 폴더의 설정 파일을 읽어 밖으로 보내지 못하게, 이 모드에서는 점으로 시작하는 파일·폴더(`.claude.json`, `.ssh`)와 JSON 을 내주지 않는다 (`linkFolderParts`). 원래 이 문서 루트는 웹 형식(HTML·CSS·JS·그림·글꼴)만 내준다.

## 시험
- `browserWorkspace.test.js`: 링크 폴더에서 HTML·CSS 는 내주고 JSON·점 파일·점 폴더는 404, 파일·드라이브 루트·UNC 는 링크 폴더로 받지 않음.
- `agentChat/ipc.test.js`: 작업 폴더 밖 링크는 파일의 폴더와 `linkFolder: true` 로, 안의 링크는 작업 폴더와 `linkFolder: false` 로 연다.
