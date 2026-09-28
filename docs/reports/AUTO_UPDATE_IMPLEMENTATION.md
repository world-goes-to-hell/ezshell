# Electron 자동 업데이트 + 배포 설정 구현 완료

## 구현 개요

`electron-updater` 패키지를 사용한 자동 업데이트 시스템이 완전히 구축되었습니다.

---

## 구현된 파일 목록

### 1. Backend (Main Process)

#### **main.js**
- `autoUpdater` 모듈 import 추가
- `setupAutoUpdater()` 함수 구현
  - 업데이트 자동 다운로드: `false` (사용자 확인 후 다운로드)
  - 종료 시 자동 설치: `true`
  - 이벤트 리스너: checking, available, downloading, downloaded, error
  - 앱 시작 3초 후 자동 업데이트 확인
- `sendUpdateStatus()` 함수로 렌더러에 업데이트 상태 전송
- IPC 핸들러 추가:
  - `check-for-updates`: 수동 업데이트 확인
  - `download-update`: 업데이트 다운로드
  - `install-update`: 앱 재시작 및 설치
  - `get-app-version`: 현재 앱 버전 반환

#### **src/preload.js**
- 자동 업데이트 API 추가:
  - `checkForUpdates()`
  - `downloadUpdate()`
  - `installUpdate()`
  - `getAppVersion()`
  - `onUpdateStatus(callback)` - 업데이트 상태 리스너

### 2. Frontend (Renderer Process)

#### **src/renderer/stores/updateStore.ts** (신규)
- Zustand 스토어로 업데이트 상태 관리
- UpdateStatus: `idle | checking | available | not-available | downloading | downloaded | error`
- UpdateInfo 인터페이스:
  - version, releaseDate, releaseNotes
  - percent, transferred, total, bytesPerSecond (다운로드 진행률)
  - errorMessage
- 액션:
  - `setInfo()`: 업데이트 정보 업데이트
  - `setDismissed()`: 알림 숨김
  - `setAppVersion()`: 앱 버전 설정
  - `reset()`: 상태 초기화

#### **src/renderer/components/Update/UpdateNotification.tsx** (신규)
- **UpdateNotification 컴포넌트**:
  - 업데이트 사용 가능 알림 (파란색 정보 아이콘)
  - 다운로드 진행 상태 (프로그레스 바 + 속도 표시)
  - 다운로드 완료 알림 (재시작 버튼)
  - Framer Motion 애니메이션 (슬라이드업 + 페이드)
  - 사용자 액션: 다운로드, 재시작, 알림 숨김

- **VersionInfo 컴포넌트**:
  - Footer에 표시되는 버전 정보
  - 클릭 시 수동 업데이트 확인
  - 상태 표시: 확인 중 (스피너), 새 버전 (NEW 뱃지), 설치 준비 (READY 뱃지)

#### **src/renderer/App.tsx**
- `UpdateNotification` import 및 렌더링 (ToastContainer 아래)

#### **src/renderer/components/Footer/Footer.tsx**
- `VersionInfo` 컴포넌트를 footer 우측에 표시
- 하드코딩된 버전 문자열 제거

#### **src/renderer/styles/globals.css**
- 업데이트 알림 스타일 추가 (파일 끝부분):
  - `.update-notification`: 고정 위치 알림 (우측 하단)
  - `.update-icon-*`: 상태별 아이콘 스타일
  - `.update-progress-bar`: 다운로드 진행 바
  - `.update-action-btn`: 다운로드/재시작 버튼
  - `.version-info`: Footer 버전 표시
  - `.version-badge`: NEW/READY 뱃지
  - `@keyframes pulse`: 다운로드 중 펄스 애니메이션

### 3. Build & Deploy 설정

#### **package.json**
- **빌드 스크립트 추가**:
  ```json
  "build:publish": "electron-vite build && electron-builder --win --publish always"
  "build:nsis": "electron-vite build && electron-builder --win nsis"
  "build:portable": "electron-vite build && electron-builder --win portable"
  "build:all": "electron-vite build && electron-builder --win nsis --win portable"
  ```

- **electron-builder 설정 업데이트**:
  - `directories.output`: "release"
  - `win.target`: NSIS (설치 프로그램) + Portable (포터블 실행파일)
  - `nsis` 설정:
    - oneClick: false (사용자 정의 설치)
    - allowToChangeInstallationDirectory: true
    - 바탕화면/시작 메뉴 바로가기 생성
  - `portable.artifactName`: "MySSHClient-${version}-portable.exe"
  - **publish 설정 (GitHub Releases)**:
    ```json
    "publish": [{
      "provider": "github",
      "owner": "REPLACE_WITH_GITHUB_USERNAME",
      "repo": "my-ssh-client",
      "releaseType": "release"
    }]
    ```

---

## 사용 방법

### 개발 모드
```bash
npm run dev
```
- 자동 업데이트 비활성화 (개발 중에는 체크하지 않음)

### 프로덕션 빌드

#### 로컬 빌드 (배포 없음)
```bash
npm run build:all
```
- NSIS 설치 프로그램 + Portable 실행파일 생성
- 출력 위치: `release/` 디렉토리

#### GitHub Releases 자동 배포
```bash
npm run build:publish
```
- **사전 준비 필요**:
  1. `package.json`의 `publish.owner`를 GitHub 사용자명으로 변경
  2. 환경변수 `GH_TOKEN` 설정 (GitHub Personal Access Token)
  3. GitHub에 저장소 생성 (`my-ssh-client`)

- **배포 과정**:
  1. Vite로 프로덕션 빌드
  2. electron-builder로 설치 파일 생성
  3. GitHub Releases에 자동 업로드
  4. `latest.yml` 파일 생성 (업데이트 확인용)

### GitHub Personal Access Token 생성
1. GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic)
2. Generate new token
3. 권한: `repo` 전체 선택
4. 환경변수 설정:
   ```bash
   # Windows (PowerShell)
   $env:GH_TOKEN="your_token_here"

   # Windows (CMD)
   set GH_TOKEN=your_token_here

   # Linux/Mac
   export GH_TOKEN=your_token_here
   ```

---

## 자동 업데이트 동작 흐름

### 1. 앱 시작 시
1. 프로덕션 모드에서만 활성화
2. 3초 후 자동으로 `autoUpdater.checkForUpdates()` 실행

### 2. 업데이트 사용 가능
1. 우측 하단에 알림 표시: "새 버전 v1.0.1 사용 가능"
2. 사용자 클릭: "다운로드" 버튼

### 3. 다운로드 중
1. 프로그레스 바 표시
2. 다운로드 속도 및 진행률 표시 (예: "45% · 2.3 MB/s")

### 4. 다운로드 완료
1. 알림 변경: "v1.0.1 다운로드 완료. 재시작하여 설치하세요."
2. 사용자 클릭: "재시작" 버튼
3. 앱 종료 후 자동 설치 및 재시작

### 5. 수동 확인
- Footer의 버전 정보 클릭 → 즉시 업데이트 확인

---

## UI/UX 특징

### 알림 디자인
- **위치**: 우측 하단 (footer 위)
- **애니메이션**: 슬라이드업 + 페이드인 (0.3초)
- **상태별 아이콘**:
  - 정보 (파란색): 새 버전 사용 가능
  - 다운로드 중 (펄스 애니메이션)
  - 완료 (초록색): 설치 준비

### 버전 정보 (Footer)
- **기본 상태**: "v1.0.0" (회색)
- **확인 중**: 회전하는 새로고침 아이콘
- **새 버전**: "NEW" 뱃지 (파란색)
- **설치 준비**: "READY" 뱃지 (초록색)
- **호버**: 배경색 변경 + 툴팁 "업데이트 확인"

### 사용자 제어
- **알림 숨김**: X 버튼 (세션 동안만 숨김)
- **다운로드 취소**: 불가능 (다운로드 시작 후 완료까지 진행)
- **설치 연기**: 가능 (앱 종료 시 자동 설치)

---

## 빌드 결과물

### NSIS 설치 프로그램
- 파일명: `My SSH Client Setup 1.0.0.exe`
- 특징:
  - 설치 경로 선택 가능
  - 바탕화면 바로가기 생성
  - 시작 메뉴 등록
  - 제어판에서 제거 가능
  - 자동 업데이트 지원

### Portable 실행파일
- 파일명: `MySSHClient-1.0.0-portable.exe`
- 특징:
  - 설치 불필요
  - USB 등에서 실행 가능
  - 자동 업데이트 지원 (사용자 데이터 폴더에 저장)

---

## 보안 고려사항

### 업데이트 검증
- electron-updater는 자동으로 서명 검증 수행
- GitHub Releases만 신뢰할 수 있는 소스로 사용
- HTTPS 전송

### 사용자 제어
- 자동 다운로드 비활성화 (`autoDownload: false`)
- 사용자 확인 후 다운로드/설치
- 설치 시점 선택 가능 (즉시 또는 다음 시작 시)

---

## 테스트 방법

### 로컬 테스트
1. 버전 1.0.0으로 빌드 및 설치
2. `package.json` 버전을 1.0.1로 변경
3. GitHub Release 생성 및 업로드
4. 앱 실행 → 3초 후 업데이트 알림 확인

### 수동 테스트
1. Footer 버전 정보 클릭
2. 즉시 업데이트 확인
3. 없으면 "업데이트 없음" (콘솔 로그)

---

## 주의사항

⚠️ **GitHub 저장소 설정 필수**:
- `package.json`의 `publish.owner`를 실제 GitHub 사용자명으로 변경
- Private 저장소의 경우 GH_TOKEN 필수

⚠️ **버전 관리**:
- `package.json`의 `version` 필드를 정확히 업데이트
- Semantic Versioning 권장 (major.minor.patch)

⚠️ **개발 모드**:
- 개발 중에는 자동 업데이트 비활성화됨
- `--dev` 플래그 또는 `ELECTRON_RENDERER_URL` 환경변수 존재 시 비활성화

---

## 추가 개선 가능 사항

1. **릴리즈 노트 표시**: `info.releaseNotes`를 모달로 표시
2. **업데이트 예약**: 특정 시간에 자동 설치
3. **베타 채널**: `allowPrerelease: true`로 베타 버전 수신
4. **다운로드 일시정지/재개**: 현재 미지원
5. **오프라인 처리**: 네트워크 오류 시 재시도 로직

---

## 빌드 확인 완료

```bash
npm run build
```
✅ 빌드 성공 (2025-02-06)
- Vite 프로덕션 빌드 완료
- 모든 파일 정상 생성
- CSS 경고 (gradient syntax) 무시 가능

---

## 구현 완료 체크리스트

- [x] electron-updater 패키지 설치 확인
- [x] main.js 자동 업데이트 로직 추가
- [x] preload.js API 노출
- [x] updateStore 상태 관리 구현
- [x] UpdateNotification 컴포넌트 작성
- [x] VersionInfo Footer 통합
- [x] globals.css 스타일 추가
- [x] package.json 빌드 스크립트 추가
- [x] package.json publish 설정 추가
- [x] 프로덕션 빌드 테스트 성공

---

## 최종 파일 목록

**수정된 파일**:
- `package.json`
- `main.js`
- `src/preload.js`
- `src/renderer/App.tsx`
- `src/renderer/components/Footer/Footer.tsx`
- `src/renderer/styles/globals.css`

**생성된 파일**:
- `src/renderer/stores/updateStore.ts`
- `src/renderer/components/Update/UpdateNotification.tsx`

**총 8개 파일** 수정/생성 완료
