# 바로 반영이 호출하는 쪽만 반영해 NoSuchMethodError 가 나던 문제

## 제보

- 실행 구성(Gradle Spring Boot, JBR 17)에서 요청 클래스에 메서드를 추가하고 컨트롤러에서 그 메서드를 부르도록 고쳤다.
- 컨트롤러는 반영되었고 요청 클래스는 반영되지 않아 `NoSuchMethodError: TxgrpMngSearchRequest.applyDataScope(...)` 로 500 이 났다.
- 제보자 쪽 에이전트는 JVM 에 `-XX:+AllowEnhancedClassRedefinition` 이 없었다고 했다 (표준 모드로 띄운 것으로 보인다).

## 원인

`watchJavaChanges` 는 저장된 파일을 300ms 단위로 묶어 컴파일하고 JDWP `RedefineClasses` 한 번으로 보낸다.
한 요청 안에서는 JVM 이 전부 받거나 전부 거부하지만, 두 파일이 다른 묶음에 들어가면 이렇게 된다.

1. 요청 클래스(메서드 추가)를 보낸다. 표준 모드의 JVM 이 거부한다. 카드에 재기동 필요가 뜬다.
2. 컨트롤러(본문만 바뀜)를 보낸다. JVM 이 받는다. 카드는 바로 반영됨으로 바뀐다.
3. 새 컨트롤러가 옛 요청 클래스에 없는 메서드를 불러 `NoSuchMethodError` 가 난다.

컴파일 오류도 같다. 오류가 난 묶음의 다른 파일은 버려져서, 오류를 고친 파일만 다음에 반영되었다.

## 수정

- `src/ipc/hotReload.js`: JVM 에 닿지 않은 묶음(거부, 컴파일 오류, 연결 없음, 반영 확인 실패)의 소스를 `carried` 에 남긴다.
  다음 저장 때 새 변경과 합쳐 다시 컴파일하고 한 요청으로 보낸다. 성공하면 비운다.
- 그래서 요청 클래스가 거부된 상태에서는 컨트롤러도 함께 거부되고, 카드는 재기동 필요를 유지한다. 앱은 옛 코드 그대로 일관되게 돈다.
- 반영 여부를 확인하지 못한 경우 같은 바이트를 다시 보내도 결과가 같으므로 다시 보낸다.

## 확인한 것

- 단위 테스트 `sends a rejected or uncompiled class again with later edits ...` (거부 → 합쳐서 다시 거부 → 컴파일 오류 → 합쳐서 반영 → 이후에는 새 파일만).
- 확장 옵션 실측: 보관함 JBR 17.0.14 에 ezShell 이 넣는 `-XX:+AllowEnhancedClassRedefinition -XX:HotswapAgent=external -javaagent:<보관함 jar>` 로 `java -version` 이 정상으로 뜬다.
  `external` 은 JBR 의 `lib/hotswap` 을 찾지 않으므로 그 폴더가 없어도 된다 (제보자가 시험한 `fatjar`·`core` 는 ezShell 이 쓰지 않는다).
- Gradle `bootRun` 에 init 스크립트로 넣는 인자가 실제 JVM 까지 가는지, 데몬을 다시 쓸 때 새 값으로 바뀌는지 시험 프로젝트로 확인했다.
