import { describe, expect, it } from 'vitest'
import { createDevelopmentErrors } from './developmentErrors.js'
import { describeRunFailure, diagnoseRun } from './runDiagnosis.js'

const kinds = results => results.map(({ kind }) => kind)

describe('one-line run failure reasons', () => {
  it('keeps the port or required Java version and ignores generic launcher footers', () => {
    expect(describeRunFailure({ lines: [
      'Web server failed to start. Port 8080 was already in use.',
      'Error: EADDRINUSE', '[ERROR] [Help 1] http://example.test/help'
    ], exitCode: 1 })).toBe('실행 포트 점검 · 8080 포트 사용 중')
    expect(describeRunFailure({ lines: [
      'java.lang.UnsupportedClassVersionError: app/Main (class file version 65.0)'
    ], exitCode: 1 })).toContain('Java 21')
  })

  it('uses framework descriptions and redacts a meaningful fallback line', () => {
    expect(describeRunFailure({ lines: [
      'APPLICATION FAILED TO START', 'Description:', '', "Failed to configure a DataSource: 'url' attribute is not specified.",
      '', 'Action:', 'Check the profile.', '[ERROR] Process terminated with exit code: 1'
    ], exitCode: 1 })).toBe('DB 설정 점검 · 데이터소스 URL 누락')
    expect(describeRunFailure({ lines: [
      'FAILURE: Build failed with an exception.', '* What went wrong:', '', 'Custom task rejected the local configuration.', '', '* Try:'
    ], exitCode: 1 })).toBe('Custom task rejected the local configuration.')
    expect(describeRunFailure({ lines: [
      'ERROR uncaught exception', 'Caused by: Error: initialization failed password=fixture-secret',
      '    at start (main.js:12:2)', '[ERROR] To see the full stack trace of the errors, re-run Maven with the -e switch.',
      '[ERROR] Re-run Maven using the -X switch to enable full debug logging.', '[ERROR] [Help 1] http://example.test/help'
    ] })).toBe('initialization failed password=****')
  })

  it('reports the exit code when there is no actual error detail', () => {
    expect(describeRunFailure({ lines: [
      '[INFO] BUILD FAILURE', '[ERROR] Process terminated with exit code: 1',
      '[ERROR] [Help 1] http://example.test/help', '    at start (main.js:12:2)'
    ], exitCode: 1 })).toBe('종료 코드 1만 확인됩니다. 로그를 확인해 주세요.')
  })

  it('extracts the MariaDB port from the Hibernate failure through Maven help output', () => {
    const endpoint = 'Socket fail to connect to host:address=(host=localhost)(port=3306)(type=primary). Connection refused: getsockopt'
    const lines = [
      '2026-11-28T12:17:13.897+09:00 WARN 96032 --- [main] o.h.engine.jdbc.spi.SqlExceptionHelper : SQL Error: 0, SQLState: 08000',
      `2026-11-28T12:17:13.897+09:00 ERROR 96032 --- [main] o.h.engine.jdbc.spi.SqlExceptionHelper : ${endpoint}`,
      'WARN o.h.e.j.e.i.JdbcEnvironmentInitiator : HHH000342: Could not obtain connection to query metadata',
      `org.hibernate.exception.JDBCConnectionException: unable to obtain isolated JDBC connection [${endpoint}] [n/a]`,
      ...Array(150).fill('    at org.hibernate.exception.internal.SQLStateConversionDelegate.convert(SQLStateConversionDelegate.java:100)'),
      '[ERROR] Process terminated with exit code: 1', '[ERROR] [Help 1] http://example.test/help'
    ]
    expect(describeRunFailure({ lines, exitCode: 1 })).toBe('DB 점검 필요 · 3306 포트 연결 실패')
    expect(diagnoseRun({ lines })).toMatchObject([{ kind: 'databaseConnection', reason: 'refused', port: 3306 }])
  })

  it.each([
    ['org.postgresql.util.PSQLException: Connection to 127.0.0.1:5432 refused.', 'DB 점검 필요 · 5432 포트 연결 실패'],
    ['ERROR com.mysql.cj.jdbc.Driver connect timed out port=3310', 'DB 점검 필요 · 3310 포트 연결 시간 초과'],
    ['org.postgresql.util.PSQLException: FATAL: password authentication failed for user "test"', 'DB 점검 필요 · 로그인 또는 접속 권한 오류'],
    ['ERROR o.h.engine.jdbc.spi.SqlExceptionHelper: Unknown database "missing_db"', 'DB 설정 점검 · 지정한 데이터베이스 없음'],
    ['Error: connect ECONNREFUSED 127.0.0.1:9000', '연결 대상 점검 · 9000 포트 연결 실패'],
    ["ERROR Could not resolve placeholder 'SPRING_DATASOURCE_URL' in value", '설정 점검 · SPRING_DATASOURCE_URL 값 누락'],
    ['ERROR JAVA_HOME is not set', 'JDK 점검 · Java 실행 환경을 찾을 수 없음'],
    ['ERR_PNPM_UNSUPPORTED_ENGINE Unsupported environment (bad pnpm and/or Node.js version)', 'Node.js 버전 점검 · 프로젝트 요구 버전과 불일치'],
    ["Error: Cannot find module 'express'", '의존성 점검 · Node 모듈을 찾을 수 없음'],
    ["Could not resolve all files for configuration ':runtimeClasspath'.", '의존성 점검 · 빌드에 필요한 패키지 또는 버전을 해결하지 못함'],
    ['app.ts(18,1): error TS2322: Type mismatch', '빌드 점검 · 컴파일 오류'],
    ['Error: EACCES: permission denied, mkdir temp', '권한 점검 · 파일 또는 실행 권한 부족'],
    ['FATAL ERROR: JavaScript heap out of memory', '메모리 점검 · 실행에 필요한 메모리 부족'],
    ['Error: getaddrinfo ENOTFOUND service.example.test', '연결 대상 점검 · 호스트 이름 조회 실패']
  ])('summarizes common failure evidence: %s', (line, summary) => {
    expect(describeRunFailure({ lines: [line], exitCode: 1 })).toBe(summary)
  })

  it('does not infer a DB error from a generic network error beside a SQL warning', () => {
    expect(describeRunFailure({ lines: [
      'WARN o.h.engine.jdbc.spi.SqlExceptionHelper: SQL Error: 0, SQLState: 08000',
      'Error: connect ECONNREFUSED 127.0.0.1:9000'
    ] })).toBe('연결 대상 점검 · 9000 포트 연결 실패')
  })

  it('links a nested socket error to its immediate cause instead of a nearby JDBC warning', () => {
    const refused = 'Caused by: java.net.ConnectException: Connection refused'
    const redis = [
      'WARN o.h.engine.jdbc.spi.SqlExceptionHelper: SQL Error: 0, SQLState: 01000',
      'ERROR org.springframework.boot.SpringApplication: Application run failed',
      'Caused by: io.lettuce.core.RedisConnectionException: Unable to connect to 127.0.0.1/<unresolved>:6379',
      refused
    ]
    expect(diagnoseRun({ lines: redis })).toEqual([])
    expect(describeRunFailure({ lines: redis, exitCode: 1 })).toBe('연결 대상 점검 · 연결 실패')
    expect(describeRunFailure({ lines: [
      'Caused by: org.postgresql.util.PSQLException: Could not connect to the JDBC server (port=5432)',
      '    at org.postgresql.core.ConnectionFactory.openConnection(ConnectionFactory.java:54)',
      refused
    ], exitCode: 1 })).toBe('DB 점검 필요 · 5432 포트 연결 실패')
  })
})

describe('local run diagnosis', () => {
  it('reads error groups and recent lines, normalizes classes, and deduplicates a repeated cause', () => {
    const errors = createDevelopmentErrors()
    errors.addError('java.lang.ClassNotFoundException: org.example.JdbcDriver')
    errors.addError('java.lang.NoClassDefFoundError: org/example/JdbcDriver')
    const lines = [...errors.lines(), 'Caused by: java.lang.ClassNotFoundException: example.Loaded$Inner']
    expect(diagnoseRun({ groups: errors.groups(), lines })).toEqual([
      expect.objectContaining({ kind: 'missingClass', className: 'org.example.JdbcDriver' }),
      expect.objectContaining({ kind: 'missingClass', className: 'example.Loaded$Inner' })
    ])
  })

  it('maps modern and legacy class format versions to the required JDK', () => {
    const lines = [
      'java.lang.UnsupportedClassVersionError: app/Main has been compiled by a more recent version of the Java Runtime (class file version 65.0), this version of the Java Runtime only recognizes class file versions up to 61.0',
      'java.lang.UnsupportedClassVersionError: app/Legacy : Unsupported major.minor version 52.0',
      'java.lang.UnsupportedClassVersionError: Preview features are not enabled for app/Preview (class file version 61.65535). Try running with --enable-preview'
    ]
    expect(diagnoseRun({ lines })).toMatchObject([
      { kind: 'jdkVersion', classMajor: 65, requiredFeature: 21 },
      { kind: 'jdkVersion', classMajor: 52, requiredFeature: 8 },
      { kind: 'jdkVersion', classMajor: 61, requiredFeature: 17, preview: true }
    ])
  })

  it('keeps a JDK suggestion when an old JVM reports no class file version', () => {
    expect(diagnoseRun({ lines: ['java.lang.UnsupportedClassVersionError: Bad version number in .class file'] }))
      .toMatchObject([{ kind: 'jdkVersion', requiredFeature: null }])
  })

  it('finds a JNDI name, javac encoding, Spring Boot port and the affected Tomcat connector', () => {
    const groups = [{ at: 1, lines: [
      'SEVERE: Failed to initialize end point associated with ProtocolHandler ["http-nio-9090"]',
      'Caused by: java.net.BindException: Address already in use: bind'
    ] }]
    const lines = [
      'javax.naming.NameNotFoundException: Name [java:comp/env/jdbc/Inventory] is not bound in this Context.',
      '\u001b[31mMain.java:8: error: unmappable character (0xB0) for encoding UTF-8\u001b[0m',
      'Web server failed to start. Port 8080 was already in use.',
      'Error: listen EADDRINUSE: address already in use :::5173'
    ]
    expect(diagnoseRun({ groups, lines })).toMatchObject([
      { kind: 'portInUse', port: 9090 },
      { kind: 'jndi', name: 'jdbc/Inventory' },
      { kind: 'sourceEncoding', encoding: 'UTF-8' },
      { kind: 'portInUse', port: 8080 },
      { kind: 'portInUse', port: 5173 }
    ])
  })

  it('avoids a jar suggestion for initializer errors and does not guess between two ports', () => {
    const lines = [
      'java.lang.NoClassDefFoundError: Could not initialize class com.example.Config',
      'java.lang.NoClassDefFoundError: com/example/Legacy (wrong name: com/example/New)',
      'Starting ProtocolHandler ["http-nio-8080"]',
      'Starting ProtocolHandler ["http-nio-9080"]',
      'Caused by: java.net.BindException: Address already in use'
    ]
    expect(diagnoseRun({ lines })).toMatchObject([{ kind: 'portInUse', port: null }])
  })

  it('ignores optional class and JNDI lookups in warning and debug logs', () => {
    const lines = [
      '[DEBUG] Optional probe java.lang.ClassNotFoundException: example.OptionalDriver',
      '[WARN] No JNDI resource for an optional extension',
      'Caused by: javax.naming.NameNotFoundException: Name [jdbc/Optional] is not bound in this Context.',
      '    at example.OptionalProbe.find(OptionalProbe.java:11)',
      'Caused by: java.lang.ClassNotFoundException: example.OptionalHandler',
      'Exception in thread "main" java.lang.ClassNotFoundException: example.Required'
    ]
    expect(diagnoseRun({ lines })).toMatchObject([{ kind: 'missingClass', className: 'example.Required' }])
  })
})

describe('Maven 3.6, 3.8 and 3.9 failure diagnosis', () => {
  it('recognizes a Maven 3.6.3 transfer failure with a separate DNS cause', () => {
    const lines = [
      '[FATAL] Non-resolvable parent POM: Could not transfer artifact org.ezshell.fixture:demo-parent:pom:1.0 from/to legacy (http://legacy.invalid/repo/): transfer failed',
      ...Array.from({ length: 8 }, () => '    at sun.reflect.NativeMethodAccessorImpl.invoke0(Native Method)'),
      'Caused by: java.net.UnknownHostException: legacy.invalid'
    ]
    expect(diagnoseRun({ lines })).toMatchObject([
      { kind: 'mavenRepositoryUnavailable', repositoryId: 'legacy', reason: 'unknownHost' }
    ])
  })

  it('returns the original repository ID from a Maven 3.8.9 HTTP blocker error', () => {
    const lines = ['[FATAL] Non-resolvable parent POM for org.ezshell.fixture:demo:1.0: Could not transfer artifact org.ezshell.fixture:demo-parent:pom:1.0 from/to maven-default-http-blocker (http://0.0.0.0/): Blocked mirror for repositories: [legacy (http://legacy.invalid/repo/, default, releases+snapshots)] and \'parent.relativePath\' points at no local POM @ line 1, column 93']
    expect(diagnoseRun({ lines })).toMatchObject([{ kind: 'mavenHttpBlocked', repositoryId: 'legacy' }])
  })

  it('treats Maven 3.9.16 (absent) with a 401 as authentication, not a missing artifact', () => {
    const lines = [
      '[FATAL] Non-resolvable parent POM: The following artifacts could not be resolved: org.ezshell.fixture:demo-parent:pom:1.0 (absent): Could not transfer artifact org.ezshell.fixture:demo-parent:pom:1.0 from/to legacy (http://127.0.0.1:8081/unauthorized/): status code: 401, reason phrase: Unauthorized (401)',
      'Caused by: org.eclipse.aether.transfer.ArtifactTransferException: status code: 401, reason phrase: Unauthorized (401)'
    ]
    expect(diagnoseRun({ lines })).toMatchObject([{ kind: 'mavenUnauthorized', repositoryId: 'legacy' }])
  })

  it('distinguishes HTTP 404, missing artifacts and TLS failures without exposing a raw URL', () => {
    const lines = [
      '[ERROR] Could not transfer artifact sample:module:jar:1 from/to retired (https://user:top-secret@archive.invalid/maven/private-token): status code: 404, reason phrase: Not Found',
      '[ERROR] Could not find artifact sample:module:jar:tests:1.0-SNAPSHOT in empty (file:///private/repo)',
      '[ERROR] Could not transfer artifact sample:module:jar:1 from/to legacy (https://legacy.invalid/maven): PKIX path building failed',
      '[ERROR] Could not transfer artifact sample:module:jar:2 from/to incompatible (https://example.invalid/maven): Received fatal alert: protocol_version',
      '[ERROR] Could not transfer artifact sample:module:jar:3 from/to mirror (https://example.invalid/maven): Received fatal alert: handshake_failure'
    ]
    const results = diagnoseRun({ lines })
    expect(results).toMatchObject([
      { kind: 'mavenRepositoryUnavailable', repositoryId: 'retired', reason: 'notFound' },
      { kind: 'mavenArtifactMissing', repositoryId: 'empty', artifact: 'sample:module:jar:tests:1.0-SNAPSHOT' },
      { kind: 'mavenTls', repositoryId: 'legacy' },
      { kind: 'mavenTls', repositoryId: 'incompatible' },
      { kind: 'mavenTls', repositoryId: 'mirror' }
    ])
    expect(JSON.stringify(results)).not.toMatch(/top-secret|private-token|archive\.invalid|file:\/\/\//)
  })

  it('classifies compiler release support and plugin JDK requirements', () => {
    const lines = [
      '[ERROR] Failed to execute goal org.apache.maven.plugins:maven-compiler-plugin:3.8.1:compile: Fatal error compiling: invalid target release: 17',
      '[ERROR] Failed to execute goal org.apache.maven.plugins:maven-compiler-plugin:3.13.0:compile: release version 21 not supported',
      '[ERROR] Plugin org.example:sample-maven-plugin:1.0 requires Java version 11',
      '[ERROR] Failed to execute goal org.apache.maven.plugins:maven-compiler-plugin:3.8.1:compile: Fatal error compiling: invalid flag: --release'
    ]
    expect(diagnoseRun({ lines })).toMatchObject([
      { kind: 'mavenPluginJdk', requiredFeature: 17 },
      { kind: 'mavenPluginJdk', requiredFeature: 21 },
      { kind: 'mavenPluginJdk', requiredFeature: 11 },
      { kind: 'mavenPluginJdk' }
    ])
  })

  it('does not classify a debug mirror announcement, ordinary TLS or a different compiler error', () => {
    const lines = [
      '[DEBUG] Using mirror maven-default-http-blocker (http://0.0.0.0/) for legacy (http://legacy.invalid).',
      'Caused by: javax.net.ssl.SSLHandshakeException: Received fatal alert: handshake_failure',
      '[INFO] Compiling with release version 17',
      '[ERROR] Failed to execute goal org.apache.maven.plugins:maven-compiler-plugin:3.8.1:compile: Compilation failure: cannot find symbol'
    ]
    expect(kinds(diagnoseRun({ lines }))).toEqual([])
  })

  it('requests approval for -s only when the effective Maven mirror differs from the approved mirror', () => {
    const lines = [
      '[DEBUG] Using mirror user-mirror (https://user:secret@packages.example.test/token) for legacy (http://legacy.invalid/repo/).',
      '[DEBUG] Using mirror ezshell-current (file:/local/repo) for current (http://current.invalid/repo/).',
      '[DEBUG] Using mirror ezshell-changed (https://packages.example.test/other) for changed (http://changed.invalid/repo/).',
      '[DEBUG] Using mirror irrelevant (https://packages.example.test/maven) for neighbor (https://example.test/maven).'
    ]
    expect(diagnoseRun({ lines })).toEqual([])
    const mirrors = [
      { repositoryId: 'legacy', url: 'https://packages.example.test/approved' },
      { repositoryId: 'current', url: 'file:///local/repo' },
      { repositoryId: 'changed', url: 'https://packages.example.test/approved' }
    ]
    const results = diagnoseRun({ lines, mirrors })
    expect(results).toMatchObject([
      { kind: 'mavenUserMirror', repositoryId: 'legacy', mirrorId: 'user-mirror', settingsFlag: '-s', requiresApproval: true },
      { kind: 'mavenUserMirror', repositoryId: 'changed', mirrorId: 'ezshell-changed', settingsFlag: '-s', requiresApproval: true }
    ])
    expect(JSON.stringify(results)).not.toMatch(/secret|packages\.example\.test|legacy\.invalid/)
  })
})
