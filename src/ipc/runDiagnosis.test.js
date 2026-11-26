import { describe, expect, it } from 'vitest'
import { createDevelopmentErrors } from './developmentErrors.js'
import { diagnoseRun } from './runDiagnosis.js'

const kinds = results => results.map(({ kind }) => kind)

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
