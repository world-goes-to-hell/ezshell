import { describe, expect, it } from 'vitest'
import { cleanSuggestions, jarSource, replacementUrl, suggestionTitle, USER_SETTINGS_WARNING, type RunSuggestion } from './runSuggestions'

const item = (over: Partial<RunSuggestion>): RunSuggestion => ({ id: 's1', kind: 'missingClass', message: '…', ...over })

describe('run suggestions', () => {
  it('says what went wrong, with what main found', () => {
    expect(suggestionTitle(item({ className: 'com.example.Foo' }))).toBe('클래스를 찾지 못함: com.example.Foo')
    expect(suggestionTitle(item({ kind: 'jdkVersion', requiredFeature: 17 }))).toBe('JDK 17 이상이 필요함')
    expect(suggestionTitle(item({ kind: 'jdkVersion', requiredFeature: null }))).toBe('JDK 버전이 맞지 않음')
    expect(suggestionTitle(item({ kind: 'jndi', name: 'jdbc/shop' }))).toBe('JNDI 이름을 찾지 못함: jdbc/shop')
    expect(suggestionTitle(item({ kind: 'sourceEncoding', encoding: 'UTF-8' }))).toBe('소스 인코딩이 맞지 않음 (UTF-8)')
    expect(suggestionTitle(item({ kind: 'portInUse', port: 8080 }))).toBe('포트 8080 사용 중')
    expect(suggestionTitle(item({ kind: 'portInUse', port: null }))).toBe('포트 사용 중')
    expect(suggestionTitle(item({ kind: 'mavenHttpBlocked', repositoryId: 'old-repo' }))).toBe('HTTP 저장소가 차단됨 (old-repo)')
    expect(suggestionTitle(item({ kind: 'mavenRepositoryUnavailable', reason: 'unknownHost', repositoryId: 'gone' }))).toBe('저장소 주소를 찾을 수 없음 (gone)')
    expect(suggestionTitle(item({ kind: 'mavenRepositoryUnavailable', reason: 'notFound' }))).toBe('저장소에서 찾지 못함 (404)')
    expect(suggestionTitle(item({ kind: 'mavenUnauthorized' }))).toBe('저장소 인증 실패 (401)')
    expect(suggestionTitle(item({ kind: 'mavenTls' }))).toBe('저장소 TLS 연결 실패')
    expect(suggestionTitle(item({ kind: 'mavenArtifactMissing', artifact: 'com.oracle:ojdbc6:jar:11.2' }))).toBe('의존성을 찾지 못함: com.oracle:ojdbc6:jar:11.2')
    expect(suggestionTitle(item({ kind: 'mavenPluginJdk', requiredFeature: 11 }))).toBe('빌드 플러그인에 JDK 11 필요')
    expect(suggestionTitle(item({ kind: 'mavenUserMirror', mirrorId: 'nexus', repositoryId: 'central' }))).toBe('사용자 미러가 대신 쓰임: nexus (central)')
    expect(suggestionTitle(item({ kind: 'somethingNew' }))).toBe('실행 진단')
  })

  it('takes a replacement repository as main does: https or a local file:/// folder', () => {
    expect(replacementUrl(' https://repo.example.com/maven2 ')).toEqual({ url: 'https://repo.example.com/maven2' })
    expect(replacementUrl('file:///C:/maven-repo')).toEqual({ url: 'file:///C:/maven-repo' })
    expect(replacementUrl('')).toEqual({ error: '대신 쓸 저장소 주소를 입력해 주세요.' })
    expect(replacementUrl('http://repo.example.com')).toEqual({ error: 'HTTP 주소는 쓸 수 없습니다. https:// 주소를 입력해 주세요.' })
    expect(replacementUrl('https://user:pw@repo.example.com')).toEqual({ error: '주소에 아이디·비밀번호를 넣을 수 없습니다.' })
    for (const bad of ['file://server/share/repo', 'file:////server/share', 'https://repo.example.com/a b', 'https://repo.example.com/?x=1', 'C:\\maven-repo', 'ftp://x']) {
      expect('error' in replacementUrl(bad)).toBe(true)
    }
  })

  it('keeps only well-formed suggestions and only the applies main knows', () => {
    expect(cleanSuggestions(null)).toEqual([])
    expect(cleanSuggestions([{ id: 'a', kind: 'mavenTls', message: 'm', apply: 'runScript' }, { kind: 'x' }, 'text']))
      .toEqual([{ id: 'a', kind: 'mavenTls', message: 'm', apply: undefined }])
    expect(cleanSuggestions([{ id: 'b', kind: 'mavenUserMirror', message: 'm', apply: 'mavenUserSettings' }])[0].apply).toBe('mavenUserSettings')
  })

  it('names what -s leaves out before it is approved', () => {
    for (const word of ['servers', 'proxies', 'mirrors', 'localRepository', '-s']) expect(USER_SETTINGS_WARNING).toContain(word)
  })

  it('offers the jars that hold a missing class, and nothing to approve without one', () => {
    const [withJars, without] = cleanSuggestions([
      { id: 'j', kind: 'missingClass', className: 'oracle.jdbc.OracleDriver', message: 'm', apply: 'tomcatJar',
        jars: [{ id: 'j1', path: '~/.m2/repository/com/oracle/ojdbc6.jar', coordinate: 'com.oracle:ojdbc6:11.2', source: 'maven' }, { id: 'j2', path: '' }, { path: 'lib/no-id.jar' }, null] },
      { id: 'k', kind: 'missingClass', message: 'm', apply: 'tomcatJar', jars: [] }
    ])
    expect(withJars).toMatchObject({ apply: 'tomcatJar', jars: [{ id: 'j1', path: '~/.m2/repository/com/oracle/ojdbc6.jar' }] })
    expect(withJars.jars).toHaveLength(1)
    expect(without.apply).toBeUndefined()
    // Shown only (another kind of run): the jars stay, with nothing to approve
    const [shown] = cleanSuggestions([{ id: 'r', kind: 'missingClass', message: 'm', jars: [{ id: 'x', path: 'lib/x.jar' }], jarSearchIncomplete: true }])
    expect(shown).toMatchObject({ apply: undefined, jars: [{ id: 'x' }], jarSearchIncomplete: true })
    expect(jarSource('maven')).toBe('Maven 저장소 (~/.m2)')
    expect(jarSource('elsewhere')).toBe('')
  })
})
