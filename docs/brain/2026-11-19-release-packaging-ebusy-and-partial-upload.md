# 배포: 패키징 EBUSY 와 GitHub 릴리스 일부만 올라가는 문제

2026-11-19, 2.21.0 배포 때 겪음. 2.19.1 때도 같은 일로 `release/v2.19.1b` 를 따로 만들었다.

## 증상

1. `electron-builder --win --publish always` 가 `release/v<버전>` 안에서 `win-unpacked.tmp` 를 `win-unpacked` 로 이름 바꾸다가 `EPERM` 을 되풀이하고 `EBUSY` 로 끝난다. 새 폴더 이름(`v2.21.0b`)으로 바꿔도 똑같다.
2. 결과 폴더를 저장소 밖(세션 scratchpad)으로 옮기면 패키징은 끝까지 되지만, 올리는 중에 GitHub API 가 `422 Validation Failed`(릴리스가 이미 있음)를 낸다. 릴리스는 만들어지고 블록맵 하나만 올라간 채 설치 파일·포터블·`latest.yml` 이 빠진다. 릴리스가 공개되면서 mac 빌드 워크플로는 돌아 mac 파일 4개는 붙는다.

## 원인

1. 저장소 폴더를 다른 프로그램(Orca 의 작업 폴더 감시로 보임, 예전에도 `app.asar` 를 붙잡았다)이 지켜보다가 새로 생긴 폴더를 잡는다. 저장소 밖에서 만들면 생기지 않는다.
2. electron-builder 가 파일들을 동시에 올리면서 릴리스 만들기를 두 번 시도해 하나가 422 로 실패했다 (확인한 범위: 로그의 POST /releases 422 와 남은 블록맵). 정확한 경쟁 조건은 확인하지 못했다.

## 다음 배포에서

- 결과 폴더를 처음부터 저장소 밖으로: `GH_TOKEN="$(gh auth token)" npx electron-builder --win --publish always -c.directories.output=<저장소 밖 폴더>` (화면 코드는 그 전에 `npx electron-vite build && npm run build:copy-extra`).
- 끝나면 `gh release view v<버전> --json assets` 로 지난 릴리스와 같은 8개(`Setup.exe`, `.blockmap`, `portable.exe`, `latest.yml`, mac 4개)인지 본다.
- 빠졌으면 직접 올린다. 이름은 공백이 아니라 `-`: `ezShell-Setup-<버전>.exe`, `ezShell-<버전>-portable.exe`. `latest.yml` 은 지난 릴리스 것과 같은 형식으로 만든다 (`url`/`path` 는 `ezShell-Setup-<버전>.exe`, `sha512` 는 설치 파일 SHA-512 의 base64, `size` 는 바이트 수, `releaseDate`). 블록맵은 올라간 것의 크기가 이번 빌드와 같은지 본다.
- 릴리스 본문: `gh release edit v<버전> --title "ezShell <버전>" --notes-file release-notes/<버전>.md`.
