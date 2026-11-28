# 확장 바로 반영으로 기동하면 MyBatis 앱이 sqlSessionFactory 오류로 뜨지 않음

## 증상

Spring Boot 3.2.4 + mybatis-spring-boot-starter 3.0.3 서비스를 실행 구성의 바로 반영 **확장**(JBR 17 + HotswapAgent 2.0.5)으로 띄우면 다음 오류로 기동이 멈췄다. 확장이 아닌 실행(끔·표준)은 정상이다.

```
UnsatisfiedDependencyException: ... Error creating bean with name 'xxxMapper' ...
Cannot resolve reference to bean 'sqlSessionFactory' while setting bean property 'sqlSessionFactory'
```

## 원인

화면에 보이는 메시지는 겉 증상이고, 맨 아래 `Caused by` 가 진짜 원인이다.

```
Caused by: java.io.IOException: Failed to parse mapping resource: 'file [...\mapper\PingMapper.xml]'
Caused by: java.lang.reflect.InaccessibleObjectException: Unable to make field protected final
  java.nio.channels.ReadableByteChannel sun.nio.ch.ChannelInputStream.ch accessible:
  module java.base does not "opens sun.nio.ch" to unnamed module
```

HotswapAgent 의 MyBatis 플러그인은 `XPathParser.createDocument` 앞에 코드를 끼워 넣어, 매퍼 XML 을 읽는 스트림이 어느 파일에서 왔는지 `IOUtils.extractFileNameFromInputSource` 로 알아낸다. 이 함수는 JDK 내부 필드(`sun.nio.ch.ChannelInputStream.ch`, 채널의 `path`, `FilterInputStream.in`, `Reader.lock`)를 리플렉션으로 읽는다. Java 17 은 해당 패키지가 열려 있지 않으면 접근을 거부하므로, 첫 매퍼 XML 파싱에서 예외가 나고 `sqlSessionFactory` 빈 생성이 실패한다. JBR 의 `-XX:HotswapAgent=external` 은 이 패키지들을 열어 주지 않는다.

## 수정

`src/runtimes/index.js` 의 `enhancedJvmArgs` 가 돌려주는 인자에 다음 두 개를 더했다.

- `--add-opens=java.base/sun.nio.ch=ALL-UNNAMED` (재현에서 실패한 지점)
- `--add-opens=java.base/java.io=ALL-UNNAMED` (같은 함수가 감싼 스트림·Reader 일 때 읽는 `in`·`lock` 필드)

`=` 를 쓴 한 토큰 형식으로 넣어, Gradle(JSON 환경 변수), Maven(Windows 는 환경 변수 확장), Tomcat(`CATALINA_OPTS`) 경로 모두 인자 하나로 전달된다. 확장은 JBR 17·21 에서만 쓰므로 Java 8 호환은 고려하지 않는다.

## 검증

- 같은 조합(Spring Boot 3.2.4, mybatis-spring-boot-starter 3.0.3, `SqlSessionFactoryBean` 을 직접 만드는 설정, `@Mapper` + XML)의 최소 재현 프로젝트를 JBR 17.0.14 + HotswapAgent 2.0.5 로 띄움
  - 기존 인자: 위 오류로 기동 실패 (재현)
  - `sun.nio.ch` 열기 추가: 기동, 매퍼 조회 성공
  - ezShell 과 같은 Gradle `bootRun` + `hot-reload/init.gradle` 경로, 새 인자 5개: 기동, 매퍼 조회 성공
- `src/runtimes/runtimes.test.js` 의 기대 인자를 먼저 고쳐 실패 확인 뒤 수정, 통과
