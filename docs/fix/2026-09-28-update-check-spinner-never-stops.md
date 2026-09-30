# 우측 하단 버전 클릭 시 업데이트 확인 로딩이 끝나지 않음

- 작성일: 2026-09-28

## 증상
하단 상태 표시줄의 버전(`v1.2.0`)을 눌러 업데이트를 확인하면, 최신 버전과 같을 때 로딩 아이콘이 계속 돈다.

## 원인
렌더러(`VersionInfo`)가 확인 결과를 electron-updater 의 `update-status` 이벤트로만 받았다.
- `checkForUpdates()` 는 앱이 패키징되지 않았으면(`app.isPackaged === false`, 개발 모드) **이벤트 없이** `null` 을 반환한다
  (`electron-updater/out/AppUpdater.js` `isUpdaterActive`).
- 개발 모드에서는 `setupAutoUpdater()` 도 호출되지 않아 이벤트 처리기 자체가 없다.
- IPC `check-for-updates` 는 `{ success: true }` 만 돌려주고 렌더러도 반환값을 쓰지 않았다.
→ 상태가 `checking` 에서 바뀌지 않는다. 개발 앱도 `package.json` 버전(1.2.0)이 최신 릴리스와 같아 "최신인데 계속 돈다" 로 보였다.

재현:
- 개발 앱: 클릭 후 5초 뒤에도 spinning, IPC 결과 `{ success: true }`
- 설치형과 같은 1.2.0 빌드: 1초 안에 멈춤 (이벤트가 오므로). 다만 최신이어도 아무 안내 없이 아이콘만 사라짐

## 수정
- `main.js` `check-for-updates`: 결과를 반환값에 명시 `{ success, status: 'available' | 'not-available' | 'unsupported', version }`
  (`null` 결과 = 확인을 건너뜀 = `unsupported`)
- `lib/updateCheck.ts` `resolveManualCheck`: 반환값으로 최종 상태와 안내를 결정. 이벤트가 먼저 상태를 바꿨으면 덮어쓰지 않음
- `VersionInfo.handleCheck`: IPC 예외도 오류로 처리, 결과 안내 알림
  - 최신: "최신 버전입니다 / v1.2.0"
  - 개발 모드: "업데이트를 확인할 수 없습니다 / 설치된 앱에서만 ..."
  - 실패: "업데이트 확인 실패 / <오류>"
  - 새 버전: 기존 업데이트 카드 표시 (알림 없음)

## 검증
- `resolveManualCheck` 테스트 7개 (먼저 작성), 전체 117개 통과, tsc exit 0
- 개발 앱: 멈춰 있던 로딩이 클릭 후 사라지고 개발 모드 안내 표시
- 로컬 패키징 빌드(`--dir`, 별도 폴더) + `app-update.yml`: 1초 안에 멈추고 "최신 버전입니다 v1.2.0" 표시.
  `app-update.yml` 이 없을 때는 "업데이트 확인 실패" 로 끝나는 것도 확인 (오류 경로)
