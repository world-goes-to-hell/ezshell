# 분할 쉘 연쇄 종료 / 폴더 펼침 상태 저장 실패

- 작성일: 2026-09-28
- 발견 경로: `npm run dev` 로 실제 서버에 연결해 사용하던 중 main 로그에서 확인

## 1. 다중 분할(3분할/4분할) 시 분할 쉘이 서로를 끊으며 생성 실패가 반복됨

**증상**
로그에 `Creating split shell` 과 `Split shell creation failed, auto-retry n/3` 가 수십 번 반복되고,
분할 터미널에 "분할 터미널 연결 종료" 오류가 표시된다.

**원인**
f29e23f 에서 `ssh-create-shell` 핸들러 앞부분에 "새 쉘을 만들기 전에 같은 세션의 split 스트림을 모두 종료"하는
선제 정리 코드를 넣었다. 그런데 4분할은 SplitTerminal 3개가 0 / 200 / 400ms 간격으로 같은 세션에 쉘을 요청한다.
두 번째 쉘을 만드는 순간 첫 번째(이미 동작 중인) 쉘이 끊기고, 끊긴 쪽이 재시도하면 다시 다른 쉘을 끊는 연쇄가 생긴다.
닫히는 중인 채널이 누적되면서 서버가 새 채널을 거부(Channel open failure)해 재시도 3회도 모두 실패한다.

정리 대상이라고 가정한 "오래된 스트림"은 실제로 존재하지 않는다.
- SplitTerminal 은 언마운트 시 `sshSplitClose` 로 스트림을 닫는다.
- 스트림 `close` 이벤트에서도 `sshStreams` 에서 삭제된다.
즉 `sshStreams` 에 남아 있는 스트림은 모두 살아 있는 스트림이다.

**수정**
- `main.js` `ssh-create-shell`: 선제 정리 루프를 제거했다. 최근 1초 내 split 스트림이 닫혔을 때 기다리는 로직과
  `Channel open failure` 시 1회 재시도는 유지했다.
- `SplitTerminal.tsx`: 실패 로그가 `[object Object]` 로 찍혀 원인을 알 수 없었으므로 `result.error` 를 출력한다.

## 2. folders-expanded.json 저장 시 TypeError, 폴더 펼침 상태가 복원되지 않음

**증상**
```
Failed to save ...\folders-expanded.json: TypeError [ERR_INVALID_ARG_TYPE]:
The "data" argument must be of type string ... Received undefined
```

**원인**
- 렌더러가 `saveFolders({ folders })` 로 폴더 목록만 보내고, main 은 받지 못한 `expandedFolders` 까지 저장하려 했다.
  `JSON.stringify(undefined)` 가 `undefined` 라서 `writeFileSync` 가 예외를 던진다.
- 불러올 때도 `expandedFolders` 를 읽지 않아, 펼침 상태 저장/복원은 처음부터 동작한 적이 없었다.

**수정**
- `sessionStore.saveToBackend`, `toggleFolder` 에서 `expandedFolders` 를 배열로 함께 저장한다.
  folders.json 은 암호화 없이 JSON 으로만 저장되므로 토글마다 저장해도 부담이 없다.
- `loadFromBackend` 에서 `expandedFolders` 를 Set 으로 복원한다.
- `main.js` `save-folders`: `expandedFolders` 가 배열일 때만 저장한다.
