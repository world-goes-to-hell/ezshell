import { useCallback, useEffect, useState } from 'react'
import { takePendingJdkFeature } from '../../lib/settingsNavigation'
import { formatBytes } from '../../lib/mcpLabels'
import type { ApacheToolBuild, ApacheToolRuntime, HotswapAgentStatus, JdkBuild, JdkProgress, JdkRuntime, JdkVendor } from '../../types'
import { ApacheToolSettings } from './ApacheToolSettings'
import './JdkSettings.css'

const FEATURES = Array.from({ length: 20 }, (_, index) => 25 - index)
const JBR_FEATURES = [21, 17]
const AGENT = 'hotswap-agent'
const VENDOR_NAMES: Record<JdkVendor, string> = { temurin: 'Eclipse Temurin', zulu: 'Azul Zulu', jbr: 'JetBrains Runtime' }
const providerName = (vendor: string) => vendor === 'temurin' || vendor === 'zulu' || vendor === 'jbr' ? VENDOR_NAMES[vendor] : vendor

export function JdkRequirementNotice({ feature, jdks, onInstall }: { feature: number | null; jdks: readonly JdkRuntime[]; onInstall?: () => void }) {
  if (!feature || jdks.some(jdk => jdk.feature >= feature)) return null
  return <div className="jdk-requirement" role="status">
    <span>이 프로젝트에는 JDK {feature} 이상이 필요합니다.</span>
    {onInstall && <button type="button" className="btn-secondary" onClick={onInstall}>JDK 받기</button>}
  </div>
}

export function JdkSettings() {
  const api = window.electronAPI
  const [jdks, setJdks] = useState<JdkRuntime[] | null>(null)
  const [hotswapAgent, setHotswapAgent] = useState<HotswapAgentStatus | null>(null)
  const [tools, setTools] = useState<ApacheToolRuntime[] | null>(null)
  // Opened from a run preset's JDK notice (lib/settingsNavigation.ts): 받기 open at that version
  const [asked] = useState(takePendingJdkFeature)
  const [expanded, setExpanded] = useState(asked !== null)
  const [vendor, setVendor] = useState<JdkVendor>('temurin')
  const [feature, setFeature] = useState(asked ?? 17)
  const [build, setBuild] = useState<JdkBuild | null>(null)
  const [lookingUp, setLookingUp] = useState(false)
  const [lookupError, setLookupError] = useState('')
  const [retry, setRetry] = useState(0)
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null)
  const [progress, setProgress] = useState<JdkProgress | null>(null)
  const [installing, setInstalling] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [registering, setRegistering] = useState(false)
  const [pendingRemoval, setPendingRemoval] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const runtimes = await api.runtimesList()
      setJdks(runtimes.jdks)
      setHotswapAgent(runtimes.hotswapAgent)
      setTools(runtimes.tools)
    } catch { setNotice({ text: '개발 도구 목록을 읽지 못했습니다.', error: true }) }
  }, [api])

  useEffect(() => {
    void refresh()
    return api.onRuntimesProgress(next => {
      setProgress(next)
      if (next === null) void refresh()
    })
  }, [api, refresh])

  useEffect(() => {
    if (!expanded) return
    let current = true
    setLookingUp(true)
    setBuild(null)
    setLookupError('')
    void api.runtimesAvailable(vendor, feature).then(result => {
      if (!current) return
      setBuild(result.jdk)
      setLookupError(result.error ?? '')
    }).catch(() => {
      if (current) setLookupError('공급자 목록을 확인하지 못했습니다.')
    }).finally(() => {
      if (current) setLookingUp(false)
    })
    return () => { current = false }
  }, [api, expanded, vendor, feature, retry])

  const busy = installing || progress !== null
  const selectedBuild = build?.vendor === vendor && build.feature === feature ? build : null
  const alreadyInstalled = Boolean(jdks?.some(jdk => jdk.id === selectedBuild?.id))
  const legacy = feature === 6 || feature === 7
  const localLegacy = legacy ? jdks?.find(jdk => !jdk.managed && jdk.feature === feature) : undefined

  const install = async (agent = false, apache?: ApacheToolBuild) => {
    if (busy || registering || removing || (!agent && !apache && !selectedBuild)) return
    const label = apache ? 'Apache 도구' : agent ? 'HotswapAgent' : 'JDK'
    setInstalling(true)
    setNotice(null)
    try {
      const result = apache
        ? await api.runtimesToolInstall(apache.tool, apache.series).then(outcome => outcome.ok ? { ...outcome, version: outcome.tool.version } : outcome)
        : agent
          ? await api.runtimesHotswapInstall().then(outcome => outcome.ok ? { ...outcome, version: null } : outcome)
          : await api.runtimesInstall(vendor, feature).then(outcome => outcome.ok ? { ...outcome, version: outcome.jdk.version } : outcome)
      if (result.ok) {
        setNotice({ text: result.version ? `보관함에 ${label} ${result.version} 설치를 완료했습니다.` : 'HotswapAgent를 보관함에 추가했습니다.' })
        await refresh()
      } else setNotice(result.cancelled ? { text: `${label} 받기를 취소했습니다.` } : { text: result.error ?? `${label}를 받지 못했습니다.`, error: true })
    } catch { setNotice({ text: `${label}를 받지 못했습니다.`, error: true }) }
    finally { setInstalling(false); setCancelling(false) }
  }

  const registerTomcat = async () => {
    if (busy || removing || registering) return
    setRegistering(true)
    setNotice(null)
    try {
      const result = await api.runtimesTomcatRegister()
      if (result.ok) {
        setNotice({ text: `Tomcat ${result.tool.version} 폴더 등록을 완료했습니다.` })
        await refresh()
      } else if (!result.cancelled) setNotice({ text: result.error ?? 'Tomcat 6 폴더를 등록하지 못했습니다.', error: true })
    } catch { setNotice({ text: 'Tomcat 6 폴더를 등록하지 못했습니다.', error: true }) }
    finally { setRegistering(false) }
  }

  const cancel = async () => {
    setCancelling(true)
    try { if (!await api.runtimesCancel()) setCancelling(false) }
    catch { setCancelling(false); setNotice({ text: '받기를 취소하지 못했습니다.', error: true }) }
  }

  const remove = async (id: string, apache: boolean) => {
    if (busy || removing || registering) return
    setRemoving(true)
    setNotice(null)
    const label = apache ? 'Apache 도구' : id === AGENT ? 'HotswapAgent' : 'JDK'
    try {
      const result = apache ? await api.runtimesToolRemove(id) : id === AGENT ? await api.runtimesHotswapRemove() : await api.runtimesRemove(id)
      if (result.ok) {
        setPendingRemoval(null)
        setNotice({ text: `보관함에서 ${label}를 지웠습니다.` })
        await refresh()
      } else setNotice({ text: result.error, error: true })
    } catch { setNotice({ text: `${label}를 지우지 못했습니다.`, error: true }) }
    finally { setRemoving(false) }
  }

  const removeButtons = (id: string, label: string, apache = false) => pendingRemoval === id ? <div className="jdk-actions">
    <button type="button" className="btn-secondary" disabled={removing} onClick={() => setPendingRemoval(null)}>취소</button>
    <button type="button" className="btn-secondary" disabled={busy || removing || registering} onClick={() => void remove(id, apache)}>삭제 확인</button>
  </div> : <button type="button" className="btn-secondary" disabled={busy || removing || registering} aria-label={`${label} 지우기`} onClick={() => setPendingRemoval(id)}>지우기</button>

  const renderList = (managed: boolean) => {
    const visible = jdks?.filter(jdk => jdk.managed === managed)
    return <section className="jdk-list-section">
      <h4>{managed ? '받은 JDK' : '이 PC에서 찾은 JDK'}</h4>
      {!visible ? <p className="settings-section-desc">목록 확인 중…</p> : visible.length === 0 ? (
        <p className="settings-section-desc">{managed ? '받은 JDK가 없습니다.' : '찾은 JDK가 없습니다.'}</p>
      ) : <ul className="jdk-list">
        {visible.map(jdk => <li key={jdk.id} id={`jdk-${jdk.id}`} tabIndex={jdk.managed ? undefined : -1}>
          <div className="jdk-item-name">
            <strong>{providerName(jdk.vendor)} {jdk.version}</strong>
            <span>{[jdk.arch === 'unknown' ? null : jdk.arch, jdk.folder, jdk.sizeBytes === undefined ? null : formatBytes(jdk.sizeBytes)].filter(Boolean).join(' · ')}</span>
          </div>
          {managed && removeButtons(jdk.id, jdk.version)}
        </li>)}
      </ul>}
    </section>
  }

  return <section className="settings-section jdk-settings">
    <div className="jdk-heading">
      <h3 className="settings-section-title">JDK 보관함</h3>
      <button type="button" className="btn-secondary" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>JDK 받기</button>
    </div>
    <p className="settings-section-desc">받은 JDK는 ezShell 실행 구성에서 선택해 사용합니다.</p>
    {expanded && <div className="jdk-download">
      <div className="jdk-choice-row">
        <label>공급자<select value={vendor} disabled={busy} onChange={event => {
          const next = event.target.value as JdkVendor
          setVendor(next)
          if (next === 'jbr' && !JBR_FEATURES.includes(feature)) setFeature(21)
        }}>
          <option value="temurin">Eclipse Temurin (추천)</option>
          <option value="zulu">Azul Zulu</option>
          <option value="jbr">JetBrains Runtime (확장 바로 반영)</option>
        </select></label>
        <label>버전<select value={feature} disabled={busy} onChange={event => setFeature(Number(event.target.value))}>
          {(vendor === 'jbr' ? JBR_FEATURES : FEATURES).map(version => <option key={version} value={version}>JDK {version}</option>)}
        </select></label>
      </div>
      <div className="jdk-actions">
        <button type="button" className="btn-secondary" title={selectedBuild?.licenseUrl} onClick={() => void api.runtimesOpenLicense(vendor)}>라이선스 보기</button>
        <button type="button" className="btn-primary" disabled={lookingUp || !selectedBuild || busy || alreadyInstalled || registering || removing} onClick={() => void install()}>
          {alreadyInstalled ? '받음' : '받아 두기'}
        </button>
      </div>
      {lookingUp ? <p className="settings-section-desc">공개 빌드를 확인하는 중…</p> : lookupError ? (
        <div className="jdk-actions" role="alert"><span>{lookupError}</span><button type="button" className="btn-secondary" onClick={() => setRetry(value => value + 1)}>다시 확인</button></div>
      ) : selectedBuild ? <p className="settings-section-desc">{selectedBuild.version} · {selectedBuild.arch}{selectedBuild.sizeBytes ? ` · ${formatBytes(selectedBuild.sizeBytes)}` : ''}</p>
        : legacy ? <>
          <p className="settings-section-desc">JDK {feature}의 공개된 무료 배포가 없습니다.</p>
          <div className="jdk-actions">
            {localLegacy && <button type="button" className="btn-secondary" onClick={() => {
              document.getElementById(`jdk-${localLegacy.id}`)?.focus()
              setNotice({ text: `실행 구성에서 ${providerName(localLegacy.vendor)} ${localLegacy.version}을 선택하세요.` })
            }}>이 PC의 JDK {feature} 쓰기</button>}
            <button type="button" className="btn-secondary" onClick={() => setFeature(8)}>JDK 8로 받기</button>
          </div>
        </>
        : <p className="settings-section-desc">이 버전의 공개 빌드가 없습니다. 이 PC에서 찾은 JDK를 실행 구성에서 선택할 수 있습니다.</p>}
    </div>}
    {busy && <div className="jdk-progress">
      <span role="status">{cancelling ? '취소 중…' : progress?.phase === 'unpack' ? '압축 푸는 중…' : progress?.phase === 'download' ? `받는 중 · ${formatBytes(progress.received)}` : '다운로드 확인 중…'}</span>
      <progress aria-label="개발 도구 받기 진행률" max={progress?.total ?? undefined} value={progress?.total ? progress.received : undefined} />
      <button type="button" className="btn-secondary" disabled={cancelling} onClick={() => void cancel()}>받기 취소</button>
    </div>}
    {notice && <p className={notice.error ? 'jdk-error' : 'settings-section-desc'} role={notice.error ? 'alert' : 'status'}>{notice.text}</p>}
    {renderList(true)}
    {renderList(false)}
    <section className="jdk-list-section">
      <h4>HotswapAgent</h4>
      <p className="settings-section-desc">JetBrains Runtime 17·21에서 확장 바로 반영에 사용합니다.</p>
      <div className="jdk-actions">
        <button type="button" className="btn-secondary" onClick={() => void api.runtimesOpenLicense(AGENT)}>HotswapAgent 라이선스</button>
        {hotswapAgent?.installed ? <>
          <span>받음 · {hotswapAgent.version}</span>
          {removeButtons(AGENT, 'HotswapAgent')}
        </> : <button type="button" className="btn-primary" disabled={!hotswapAgent || busy || removing || registering} onClick={() => void install(true)}>HotswapAgent 받기</button>}
      </div>
    </section>
    <ApacheToolSettings tools={tools} busy={busy || removing || registering} onInstall={build => void install(false, build)}
      onRegisterTomcat={registerTomcat} removeButtons={(id, label) => removeButtons(id, label, true)} />
  </section>
}
