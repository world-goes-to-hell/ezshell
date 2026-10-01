# 작업표시줄/exe 에 앱 아이콘 대신 Electron 기본 아이콘이 보이던 문제 + ezShell 아이콘

## 증상
- 설치본, 개발 모드 모두 작업표시줄에 Electron 기본 아이콘이 보였다.

## 원인
1. `package.json` `build.win.signAndEditExecutable: false` (최초 커밋부터): electron-builder 가 exe 를 수정하지 않아 `build.win.icon` 이 exe 에 들어가지 않았다.
   빌드된 `My SSH Client.exe` 에서 아이콘을 꺼내 보면 Electron 아이콘이었다.
2. `BrowserWindow` 에 `icon` 을 지정하지 않아, 작업표시줄은 exe 아이콘을 그대로 썼다.
3. 기존 `assets/icon.ico` 는 32px 로 읽으면 깨진 무늬가 나오는 파일이었다.

## 수정
| 파일 | 내용 |
|------|------|
| `assets/icon.svg` | 새 ezShell 아이콘 원본 (파란 둥근 사각형 + 흰 `eZ` + 민트 커서 밑줄, 32px 미만은 밑줄 생략) |
| `scripts/build-icon.cjs`, `scripts/ico.cjs` (+테스트) | Electron 으로 크기별(16~256) 렌더링 → ICO (64px 이하 BMP, 256px PNG) / PNG. `npm run build:icon` |
| `package.json` | `signAndEditExecutable: true`, `build:icon` 스크립트 |
| `electron.vite.config.ts` | 빌드 때 `assets/icon.ico` → `out/main/icon.ico` 복사 |
| `main.js` | 메인/터미널/SFTP 창 모두 `icon: WINDOW_ICON` |

### 왜 이렇게 했나
- exe 아이콘(바로가기, 시작 메뉴, 고정 아이콘)과 창 아이콘(실행 중 작업표시줄)은 따로 정해지므로 둘 다 고쳤다.
  창 아이콘만 있어도 실행 중에는 보이지만, 바탕화면/시작 메뉴 바로가기는 exe 아이콘을 쓴다.
- NSIS 설치 아이콘(installerIcon 등)도 같은 ico 를 쓰므로, 작은 크기는 모든 Windows 소비자가 읽는 BMP 로 넣었다.
- `signAndEditExecutable` 을 왜 껐는지는 기록이 없다. 켜고 `--dir` 빌드가 성공하는 것을 확인했다 (서명 인증서가 없어 서명은 건너뜀).

## 검증
- ICO 작성 테스트 2개
- `electron-builder --win --dir -c.win.signAndEditExecutable=true` 로 별도 폴더에 빌드 → `ezShell.exe` 아이콘이 eZ, app.asar 에 `out/main/icon.ico` 포함
- 개발 모드 실행 → 작업표시줄에 eZ 아이콘 표시 (화면 캡처로 확인)
- 설치형(NSIS) 전체 빌드와 설치 후 바로가기 아이콘은 다음 릴리스 때 확인한다.
  Windows 아이콘 캐시 때문에 이전 아이콘이 남아 보이면 `ie4uinit.exe -show` 로 갱신한다.

## 디자인 교체 (같은 날, 사용자 선택)
- 첫 디자인(파란 둥근 사각형 + 흰 eZ)이 마음에 들지 않아 초안 6개 → "터미널 프롬프트" 방향 선택 → 글꼴 8개 비교 → **Segoe UI Black** 확정.
- 최종: 어두운 둥근 사각형, 민트 `❯` 프롬프트, 흰 `eZ`, 민트 커서 밑줄(32px 이상).
- `eZ` 는 글꼴 대신 도형 경로로 넣었다 (opentype.js 로 `C:\Windows\Fonts\seguibl.ttf` 에서 윤곽선 추출). 글꼴이 없는 환경에서도 같은 모양으로 다시 만들 수 있다.
  Segoe UI 는 Windows 기본 글꼴이다. 글꼴 파일 자체를 배포하지 않고 래스터 아이콘과 윤곽선만 쓴다.
- 확인: 개발 모드 창 아이콘(WM_GETICON 32/16px)이 새 디자인. 같은 electron.exe 로 먼저 뜬 다른 창이 있으면 작업표시줄 버튼은 그 창의 아이콘을 보여 줄 수 있다.

## 타이틀바 아이콘 (사용자 요청)
- 메인 창 타이틀바 왼쪽, `ezShell` 앞에 16px 아이콘. `npm run build:icon` 이 `src/renderer/assets/app-icon.svg`(class="detail" 요소를 뺀 작은 크기용)를 함께 만든다 (`scripts/iconSvg.cjs` + 테스트).
- 처음에는 이미지가 뜨지 않았다: Vite 가 4KB 미만 SVG 를 data: URL 로 인라인했고, 페이지 CSP `default-src 'self'` 가 data: 이미지를 막았다.
  CSP 를 넓히지 않고 `?no-inline` 으로 파일로 내보내게 했다 (빌드 결과 `out/renderer/assets/app-icon-*.svg`).
- 확인: 다크/라이트 테마 타이틀바 캡처, 빌드 산출물에 data:image/svg+xml 없음.

## 크기 키움 (사용자 요청 "작업표시줄 아이콘이 작아 보임")
- 원인: 타일이 256 캔버스의 사방 8px 안쪽(240px)이라 24px 에서 실제 타일이 약 22.5px, 타일 안 내용 비율도 작았다. 다른 앱 아이콘은 캔버스를 거의 꽉 채운다.
- 후보 비교(여백만 제거 / +12% / +22%) 후 **B안**: 타일을 캔버스 전체(0~256, rx 60)로, 내용(❯, eZ, 밑줄)을 중심 기준 12% 확대.
- `npm run build:icon` 으로 ico/png/타이틀바 svg 재생성, 앱 빌드에 반영 확인.
