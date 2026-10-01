# ezShell

쉽고 예쁜 SSH · SFTP 클라이언트입니다. Electron + React + xterm.js 기반이며 Windows를 대상으로 배포합니다.

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
npm run build:icon  # assets/icon.svg 로 앱 아이콘(icon.ico, icon.png) 다시 만들기
```

### 4. 배포용 실행 파일 만들기
```bash
npm run build:nsis      # 설치형 (ezShell Setup x.y.z.exe)
npm run build:portable  # 포터블 (ezShell-x.y.z-portable.exe)
npm run build:all       # 설치형 + 포터블
npm run build:publish   # GitHub Releases 배포 (자동 업데이트용)
```
→ 결과물은 `release/` 폴더에 생성됩니다.

## 기능
- SSH 연결 (비밀번호 / 개인 키, 점프 호스트, 자동 재연결)
- 다중 탭, 터미널 분할, 패인 분할, 터미널 창 분리 (분리/합치기 시 화면 유지, 테마 동기화)
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
- 명령 팔레트, 스니펫, 일괄 명령 실행, 서버 모니터
- 테마 프리셋과 테마 에디터, 단축키 설정
- 마스터 비밀번호로 세션 암호화, 잠금 화면
- 자동 업데이트

## 주의사항
- 개인 사용/테스트 용도로만 사용하세요
- 저장된 세션 정보는 마스터 비밀번호로 암호화됩니다
- 이전 이름(My SSH Client)으로 쓰던 세션과 설정은 그대로 이어서 사용합니다
