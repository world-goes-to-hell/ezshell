# PostgreSQL 읽기 전용 세션은 SELECT 한 줄로 풀린다 (set_config)

## 상황

DB 클라이언트(`src/dbClient`)는 운영 DB 를 읽기 전용으로만 쓰려고 PostgreSQL 접속 시작 옵션에
`default_transaction_read_only=on` 을 넣었다. 앱의 검사기는 첫 단어가 SELECT/WITH 인 문장만 보냈다.
Docker 시험에서 INSERT·DELETE·`WITH ... DELETE` 가 모두 서버에서 거부되어 안전하다고 판단했다.

## 문제

`default_transaction_read_only` 는 보통의 세션 설정이고, 함수로도 바꿀 수 있다.

1. `SELECT set_config('default_transaction_read_only', 'off', false)` → 첫 단어가 SELECT 라서 검사기를 통과하고, 읽기 전용 트랜잭션 안에서도 실행된다. 세 번째 인자 false 라서 세션 끝까지 유지된다.
2. 다음 쿼리 `WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d` → 새 트랜잭션은 더 이상 읽기 전용이 아니라서 실행된다.

`statement_timeout` 도 같은 방법으로 풀린다. 접속할 때 한 번 확인하는 것으로는 막을 수 없다.

## 해결

- 쿼리마다 `BEGIN TRANSACTION READ ONLY` … `ROLLBACK` 으로 감싼다. 기본값이 무엇이든 그 트랜잭션은 읽기 전용이다. 첫 쿼리 뒤에는 읽기·쓰기로 바꿀 수 없다. 쿼리가 바꾼 설정은 ROLLBACK 으로 되돌아간다 (GUC 변경은 트랜잭션을 따른다).
- 검사기는 두 번째 겹으로 `set_config` 와 다른 세션·파일에 닿는 함수(`dblink*`, `pg_terminate_backend`, `pg_advisory_*`, `lo_*` 등)를 거부한다. 따옴표를 친 이름(`"set_config"`)과 스키마를 붙인 이름(`pg_catalog.set_config`)도 잡는다.
- `dblink` 는 자기 접속을 따로 열어서 이 세션의 읽기 전용과 관계가 없다. 이것은 함수 거부로만 막힌다.

## 교훈

- "읽기 전용 세션" 은 세션 설정일 뿐이고 사용자가 보내는 SQL 로 바뀔 수 있다. 사용자 쿼리마다 서버가 강제하는 범위(트랜잭션)를 다시 씌워야 한다.
- 시험할 때는 막고 싶은 문장 하나만 보지 말고, "앞 쿼리가 세션 상태를 바꾼 뒤의 다음 쿼리" 를 시험해야 한다. 실제 시험 스크립트에 이 순서를 넣었다 (검사기를 거치지 않고 드라이버로 직접 보냄).
- MySQL 에는 같은 함수가 없다 (`SET TRANSACTION` 은 문장이고, 저장 함수 안에서도 쓸 수 없다). 대신 실행되는 주석 `/*! ... */` 이 검사기를 피하는 길이었다.
