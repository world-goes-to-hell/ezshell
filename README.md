# ezShell

쉽고 예쁜 SSH · SFTP 클라이언트입니다. Electron + React + xterm.js 기반이며 Windows 와 macOS 를 대상으로 배포합니다. macOS 버전은 아직 테스트 중입니다.

## 다운로드

[Releases](https://github.com/world-goes-to-hell/ezshell/releases/latest) 에서 받습니다.

| 운영체제 | 파일 | 상태 |
|---|---|---|
| Windows (x64) | `ezShell-Setup-x.y.z.exe` (설치형), `ezShell-x.y.z-portable.exe` (포터블) | 정식 |
| macOS Apple Silicon (M 시리즈) | `ezShell-x.y.z-arm64.dmg` | 테스트 중 |
| macOS Intel | `ezShell-x.y.z-x64.dmg` | 테스트 중 |

### macOS 에서 처음 열 때
- 인증서 서명과 공증을 받지 않은 빌드라서 처음 열 때 macOS 가 막습니다. 앱을 우클릭해 `열기` 를 누르거나, 시스템 설정 > 개인정보 보호 및 보안에서 `그래도 열기` 를 누릅니다. 터미널에서 `xattr -dr com.apple.quarantine /Applications/ezShell.app` 를 실행해도 됩니다.
- M 시리즈 Mac 에서는 `arm64` 파일을 받으세요. `x64` 파일도 실행되지만 Rosetta 번역을 거쳐 느립니다.
- 자동 업데이트는 되지 않습니다. 새 버전이 나오면 앱이 다운로드 페이지로 안내합니다.
- 앱 단축키는 Command(⌘) 키를 씁니다 (탭 전환만 `Ctrl+Tab`).
- 아직 안 되는 것: 12.1 보다 오래된 Oracle 접속용 구성 요소, PuTTY·Xshell 세션 가져오기 (Windows 전용).

## 설치 및 실행 방법

### 1. 의존성 설치
```bash
npm install
```

### 2. 개발 모드 실행
```bash
npm run dev
```

### 3. 타입 체크 / 빌드
```bash
npm run typecheck   # TypeScript 타입 체크
npm run build       # electron-vite 빌드 (out/ 폴더에 생성)
npm run build:icon  # assets/icon.svg 로 앱 아이콘(icon.ico, icon.png, icon.icns) 다시 만들기
```

### 4. 배포용 실행 파일 만들기
```bash
npm run build:nsis      # 설치형 (ezShell Setup x.y.z.exe)
npm run build:portable  # 포터블 (ezShell-x.y.z-portable.exe)
npm run build:all       # 설치형 + 포터블
npm run build:publish   # GitHub Releases 배포 (자동 업데이트용)
npm run build:mac       # macOS 용 dmg·zip (macOS 에서만 실행됩니다)
```
→ 결과물은 `release/` 폴더에 생성됩니다.

macOS 빌드는 GitHub Actions 가 만듭니다 (`.github/workflows/mac-build.yml`). 릴리스가 공개되면 arm64·x64 용 `dmg`/`zip` 을 만들어 그 릴리스에 붙입니다.

## 기능
- SSH 연결 (비밀번호 / 개인 키, 점프 호스트, 자동 재연결)
- 다중 탭, 패인 분할, 터미널 창 분리 (분리/합치기 시 화면 유지, 테마 동기화)
- 터미널 칸 나누기: 우클릭한 칸을 좌우·상하로 나누고(한 탭에 6칸까지), 칸 위의 손잡이를 끌어 자리를 바꾸거나 탭 줄에 놓아 셸을 그대로 새 탭으로 옮김
- 로컬 터미널 탭 (이 PC 의 셸), 분할 가능
- SFTP 파일 탐색기와 전송 큐
  - 로컬/원격 두 목록, 컬럼 정렬, 키보드 단축키, 경로 북마크, 디렉토리 동기화
  - 드래그로 업로드/다운로드, 폴더 행에 놓아 그 폴더로 전송, 같은 목록 안에서 폴더로 이동
  - 같은 이름이 있으면 덮어쓰기 / 건너뛰기 / 이름 바꾸기 / 크기가 다를 때만 중 선택 (이후 충돌에 일괄 적용 가능)
  - 이번 세션에 업로드/다운로드한 파일 강조: 전송 중에는 초록 진행률 도넛, 완료는 ↑/↓, 실패는 빨간색과 사유 표시
  - 전송이 시작되거나 끝나면 목록 자동 새로고침
  - 업로드 후 원격 파일 크기를 확인해 중간에 끊긴 전송을 실패로 표시
  - SFTP 별도 창 지원 (전송 큐와 강조가 메인 창과 함께 갱신)
- 명령어 기록과 자동완성 (연결별 기록, 입력 중 후보 목록 ↑↓·Enter)
- 포트 포워딩 (Local / Remote / Dynamic)
- 세션/폴더 관리, 태그, 가져오기/내보내기
  - 사이드바 세션에 열린 탭 개수 배지(연결됨 초록 / 끊김 빨강), 배지로 탭 이동
  - 새 연결의 폴더 선택과 "폴더로 이동" 모두 폴더 트리
- Claude Code 연동 (MCP): 허용한 세션에서 Claude Code 가 명령 실행, 위험도 판정·승인 창·감사 로그·활동 표시, 자동 설정
- DB 조회 (SSH 터널로 MySQL/MariaDB, PostgreSQL, Oracle, SQL Server, 읽기 전용), 결과 추출
- 서버 파일 미리보기·편집, 로그 실시간 보기
- 도커 컨테이너 목록과 컨테이너 로그 실시간 보기
- 휴대폰 브라우저에서 원격 접속 (Tailscale)
- 명령 팔레트, 스니펫, 일괄 명령 실행, 서버 모니터
- 테마 프리셋(macOS 스타일 포함)과 테마 에디터, Glass 표면, 창 투명도
- 단축키를 원하는 키로 바꾸기 (설정 > 키보드 단축키)
- 마스터 비밀번호로 세션 암호화, 잠금 화면
- 자동 업데이트 (Windows), 새 버전 안내 (macOS)

## 주의사항
- 개인 비상업 용도로만 사용할 수 있습니다 (아래 라이선스 참고)
- 저장된 세션 정보는 마스터 비밀번호로 암호화됩니다
- 이전 이름(My SSH Client)으로 쓰던 세션과 설정은 그대로 이어서 사용합니다

## 라이선스
[PolyForm Noncommercial License 1.0.0](LICENSE)

- 허용: 개인 공부, 취미, 테스트 같은 개인 비상업 용도
- 허용: 비상업 목적의 수정과 무료 재배포 (LICENSE 파일과 저작권 표시를 함께 포함)
- 허용: 학교, 공공연구기관, 비영리단체, 정부기관의 사용
- 금지: 회사(영리 기업)의 업무 사용
- 금지: 유료 판매, 유료 제품이나 서비스에 포함하는 것

기업 또는 상업적 이용이 필요하면 [Issues](https://github.com/world-goes-to-hell/ezshell/issues)로 문의해 주세요.
