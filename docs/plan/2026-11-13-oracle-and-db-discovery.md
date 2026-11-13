# Oracle 연결과 DB 탐색 보완

- 날짜: 2026-11-13
- 구분: 중간 (운영 DB 보호와 PC 포트 예외가 걸려 있다)
- 상태: 구현·확인 완료 (배포 전)

## 요청
서버에서 Docker 로 띄운 Oracle(`51521->1521`)이 상태바의 DB 목록에 나오지 않는다.

## 원인
- 탐색이 표준 포트(3306, 3307, 5432, 5433, 1521, 1433)만 보았다. Docker 로 포트를 바꿔 띄운 DB 는 엔진과 상관없이 놓쳤다.
- Oracle 연결은 보류해 둔 상태였다 (드라이버가 SSH 터널을 넘겨받지 못한다).

## 결정 (사용자 승인)
- 탐색: `ss -ltnp`(포트를 연 프로세스), `docker ps` 의 포트 연결을 함께 본다. 읽기 명령뿐이고 DB 포트에 접속하지 않는다. `docker ps` 는 3초 제한.
- Oracle: PC 의 `127.0.0.1` 임시 포트 예외를 허용한다. 승인받은 안(탭을 닫을 때 닫음)보다 좁게 만들었다: 접속 하나를 받는 즉시 듣기를 멈추므로 포트는 접속하는 순간에만 열려 있다.
- 조회만: 쿼리마다 읽기 전용 트랜잭션 + 되돌림, SELECT·WITH 만 통과, 1,000행·30초 제한은 다른 DB 와 같다.

## 구성
- `src/dbClient/localTunnel.js`(한 번만 받는 포트), `drivers/oracle.js`, `sqlGuard.js`(Oracle 낱말 차단), `discovery.js`(Docker 포트, 프로세스), `connections.js`(등록, 서비스 이름 검사)
- 화면: `lib/dbChoices.ts`, `lib/sqlStatements.ts`(ROWNUM 미리보기), `DbConnectDialog.tsx`(서비스 이름 칸), `dbCompletion.ts`(PL/SQL 문법)
- 의존성: `oracledb` 26.0.0 (순수 JS 방식, Oracle 12.1 이상)

## 확인
- [x] 단위 테스트 (탐색, 조회 검사, 임시 포트, 서비스 이름 검사). 전체 2,369개 통과
- [x] 실제 Oracle 21c(시험 컨테이너)에 드라이버 직접 32가지: 접속, 한글·날짜·큰 숫자, 1,000행 제한, 서버의 쓰기 거부(ORA-01456), 트리, 기본 스키마, 취소, 시간 제한, SID 접속, 잘못된 서비스·비밀번호
- [x] 실제 앱 15가지: Docker 로 51521 에 내보낸 Oracle 자동 감지(컨테이너 이름 표시) → 계정 창 → DB 탭 → 트리 → 미리보기 100행 → DELETE 거부
- [x] 설치본 형태: 드라이버 로드와 조회, 쓰기 거부
- [ ] 사용자 서버의 Oracle 로 확인 (사용자 서버는 12.1 미만이었다: NJS-138. 아래 "오래된 Oracle" 로 이어짐)

## 남은 것
- Oracle 의 DDL 복사와 외래 키

## 오래된 Oracle (12.1 미만) 접속: Instant Client 를 버튼 하나로 설치

### 요청
사용자 서버의 Oracle 이 12.1 보다 오래돼 접속되지 않았다 (NJS-138). "Instant Client 방식도 좋고, 사용자가 번거롭지 않게 버튼을 누르면 바로 세팅되도록".

### 결정
- 계정 창에서 NJS-138 이 나오면 `오래된 Oracle 접속용 구성 요소` 설치 화면을 보여 준다. 버튼 하나로 받기·검사·풀기를 하고, 끝나면 앱을 다시 시작하지 않고 바로 접속된다.
- 받는 것: Oracle Instant Client **Basic 19.33** (Windows x64, 163,756,019 바이트). 11.2 이상에 접속한다. Basic Light 가 아닌 이유: 한국어 DB 의 문자 집합(KO16MSWIN949 등)은 Basic 에만 있다.
- 앱에 넣어 배포하지 않는다 (Oracle 의 무료 라이선스 조건, 설치본 크기). 사용자가 라이선스 링크를 본 뒤 Oracle 서버에서 직접 받는다.
- 설치돼 있으면 Oracle 접속은 모두 이 라이브러리 방식으로 한다. 읽기 보호·제한은 그대로다 (쿼리마다 읽기 전용 트랜잭션, 조회 문장 검사, 1,000행·30초).

### 보안
- 주소·크기·SHA-256 을 코드에 고정했다. 하나라도 다르면 버리고 설치하지 않는다. 리다이렉트는 https 의 `oracle.com` 호스트만.
- 압축 풀기는 쓰기 전에 모든 항목의 경로를 검사한다 (폴더 밖 경로가 하나라도 있으면 아무것도 쓰지 않음).
- IPC(`oracle-client-status/install/remove/license`)는 본창에서만 받고, 경로·주소를 인자로 받지 않는다.

### 구성
- `src/dbClient/oracleClient.js`(받기·검사·설치 위치 `userData/oracle-client`), `unzip.js`, `drivers/oracle.js`(방식별 모듈 사본 `copies`, 11g 의 시스템 스키마 목록)
- 화면: `DbClient/OracleClientSetup.tsx`, `DbConnectDialog.tsx`
- `network/sqlnet.ora` 의 `DISABLE_OOB=ON`: 터널로는 대역 외 자료가 가지 않아, 없으면 쿼리 취소가 서버에 닿지 않는다.
- 패키징: `asarUnpack` 에 `node_modules/oracledb/build/**`

### 확인
- [x] 단위 테스트 (받기: 크기·체크섬·리다이렉트 거부, 압축: 경로 탈출 거부). 전체 2,402개 통과
- [x] 실제 다운로드(32초), 체크섬 일치, 실제 Oracle 11g(시험 컨테이너)에 접속: 한글, 쓰기 거부, 취소, 시간 제한, 트리
- [x] 실제 앱 15가지: NJS-138 → 설치 화면 → 설치 → 다시 시작하지 않고 접속 → 조회
- [x] 설치본 형태에서 네이티브 파일 로드와 11g 조회
- [ ] 사용자 서버(`[개발] kbr`)의 Oracle 로 확인

### 남은 것
- Windows x64 만 지원한다. Microsoft Visual C++ 재배포 패키지가 없는 PC 에서는 로드가 실패하고 안내 문구가 나온다.
