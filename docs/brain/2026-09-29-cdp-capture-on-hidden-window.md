# 별도 Electron 인스턴스로 화면을 캡처할 때의 함정

## 배경
사용자가 dev 모드 앱을 쓰고 있어서, 빌드 결과물(`out/`)을 임시 프로필로 따로 띄워 CDP 로 화면을 확인했다.
2026-09-29 접힌 사이드바 개선 작업.

## 임시 프로필로 띄우기
- `electron.exe . --user-data-dir=<임시폴더> --remote-debugging-port=9444` 이면 `app.getPath('userData')` 가 임시 폴더를 가리킨다.
- `sessions.json`, `folders.json`, `folders-expanded.json`, `master.json`, `auto-unlock.dat`, `settings.json` 만 복사하면 **잠금 화면이 뜬다.**
  `safeStorage` 복호화 키가 `Local State` 파일(os_crypt)에 있으므로 이 파일도 함께 복사해야 자동 잠금 해제가 된다.
- 복사본에는 암호화된 세션과 복호화 키가 함께 있으므로, 확인이 끝나면 반드시 지운다.

## 함정
1. **창이 가려지거나 최소화되면 `Page.captureScreenshot` 이 응답하지 않는다.** 오류 없이 무한 대기라서 명령 전체가 멈춘다.
   - CDP 호출에 제한 시간(15초)을 두어 멈춤을 바로 알아차리게 한다.
   - `Emulation.setDeviceMetricsOverride` 를 걸어 둔 상태에서는 가려진 창도 한동안 캡처되었지만, 최소화된 뒤에는 이것도 소용이 없었다. 인스턴스를 다시 띄우는 것이 확실하다.
   - 사용자 화면에 창이 계속 뜨므로 사용자가 최소화할 수 있다. 확인은 짧게 끝내고 바로 종료한다.
2. **화면 크기 에뮬레이션을 걸면 합성 마우스 좌표가 실제 창과 어긋난다.** 창 크기와 다른 값으로 override 하면, `getBoundingClientRect` 로 구한 좌표에 마우스를 보내도 한 칸 아래 요소가 호버되었다.
   호버/툴팁을 확인할 때는 override 를 해제하거나 실제 창 크기(`innerWidth/innerHeight`)와 같은 값으로 건다.
3. **`Input.dispatchMouseEvent` 의 `mouseMoved` 에 `button: 'left'` 를 넣으면 버튼을 누른 채 움직인 것으로 처리된다.** 드래그로 해석되어 폴더 상태가 예상과 다르게 바뀌었다. 호버만 할 때는 `button: 'none', buttons: 0` 을 쓴다.
4. Radix Tooltip 은 스크린 리더용 사본을 숨겨서 함께 렌더링하므로 `innerText` 가 두 번 찍힌다. 중복 버그가 아니다.
