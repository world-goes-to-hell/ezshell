# My SSH Client

예쁜 UI의 SSH 클라이언트입니다. Electron + React + xterm.js 기반이며 Windows를 대상으로 배포합니다.

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
```

### 4. 배포용 실행 파일 만들기
```bash
npm run build:nsis      # 설치형 (My SSH Client Setup x.y.z.exe)
npm run build:portable  # 포터블 (MySSHClient-x.y.z-portable.exe)
npm run build:all       # 설치형 + 포터블
npm run build:publish   # GitHub Releases 배포 (자동 업데이트용)
```
→ 결과물은 `release/` 폴더에 생성됩니다.

## 기능
- SSH 연결 (비밀번호 / 개인 키, 점프 호스트, 자동 재연결)
- 다중 탭, 터미널 분할, 패인 분할, 터미널 창 분리
- SFTP 파일 탐색기와 전송 큐
- 포트 포워딩 (Local / Remote / Dynamic)
- 세션/폴더 관리, 태그, 가져오기/내보내기
- 명령 팔레트, 스니펫, 일괄 명령 실행, 서버 모니터
- 테마 프리셋과 테마 에디터, 단축키 설정
- 마스터 비밀번호로 세션 암호화, 잠금 화면
- 자동 업데이트

## 주의사항
- 개인 사용/테스트 용도로만 사용하세요
- 저장된 세션 정보는 마스터 비밀번호로 암호화됩니다
