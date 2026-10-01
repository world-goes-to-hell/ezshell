# 배포 빌드가 `release\win-unpacked\resources\app.asar` 잠금으로 실패

## 증상
`npm run build:publish` 가 패키징 단계에서 실패한다. 요약 메시지만 보면 원인을 알 수 없다.

    ⨯ ...\app-builder-bin\win\x64\app-builder.exe process failed ERR_ELECTRON_BUILDER_CANNOT_EXECUTE

`--publish never` 로 다시 실행하면 진짜 원인이 보인다.

    ⨯ remove ...\release\win-unpacked\resources\app.asar: The process cannot access the file because it is being used by another process.

## 확인한 것 (2026-09-30, v1.5.0 배포)
- `release` 폴더에서 실행 중인 프로세스는 없었다(설치형 앱은 `C:\Program Files\My SSH Client` 에서 실행 중).
- `mv app.asar ...` 도 `Device or resource busy` 로 실패 → 실제로 누군가 파일을 잡고 있다.
- 잡은 프로세스는 확정하지 못했다. 후보: Orca 의 `parcel-watcher-process`(작업 폴더 파일 감시), 백신 검사.
- 잠금은 몇 분이 지나도 풀리지 않았다.

## 대응
사용 중인 프로그램을 종료하지 않고 출력 폴더만 바꿔서 배포했다. `release/` 아래라 git 에도 잡히지 않는다.

    npx electron-vite build && npm run build:copy-extra   # 이미 성공했다면 생략
    GH_TOKEN="$(gh auth token)" npx electron-builder --win --publish always -c.directories.output=release/<버전>

## 참고
- 실패 시점에는 GitHub 릴리스가 만들어지지 않았다(`gh release view` → release not found). 재시도해도 중복 릴리스가 생기지 않는다.
- 오래된 `release/<버전>` 폴더는 잠금이 풀린 뒤 정리해도 된다.
