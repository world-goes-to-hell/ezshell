import { useCallback, useEffect, useState } from 'react'
import { takePendingJdkFeature } from '../../lib/settingsNavigation'
import { formatBytes } from '../../lib/mcpLabels'
import type { HotswapAgentStatus, JdkBuild, JdkProgress, JdkRuntime, JdkVendor, ToolBuild, ToolRuntime } from '../../types'
import { RiCupLine, RiDownloadLine, RiFlashlightLine } from 'react-icons/ri'
import { toast } from '../../stores/toastStore'
import { ApacheToolSettings } from './ApacheToolSettings'
import './JdkSettings.css'

const FEATURES = Array.from({ length: 20 }, (_, index) => 25 - index)
const JBR_FEATURES = [21, 17]
const AGENT = 'hotswap-agent'
const TOOL_NAMES: Record<string, string> = { tomcat: 'Tomcat', maven: 'Maven', ant: 'Ant', gradle: 'Gradle', node: 'Node.js' }
const VENDOR_NAMES: Record<JdkVendor, string> = { temurin: 'Eclipse Temurin', zulu: 'Azul Zulu', jbr: 'JetBrains Runtime' }
// The PC's JDKs name their maker as their release file says ("Oracle Corporation")
const providerName = (vendor: string) => vendor === 'temurin' || vendor === 'zulu' || vendor === 'jbr' ? VENDOR_NAMES[vendor]
  : vendor.replace(/\s+(Corporation|Corp\.?|Inc\.?|Ltd\.?)$/i, '')

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
  const [tools, setTools] = useState<ToolRuntime[] | null>(null)
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
  // A done download or removal is a short toast; only errors stay in the tab, above the cards
  const say = (next: { text: string; error?: boolean } | null) => {
    if (next && !next.error) { setNotice(null); toast.success('개발 도구', next.text) }
    else setNotice(next)
  }

  const refresh = useCallback(async () => {
    try {
      const runtimes = await api.runtimesList()
      setJdks(runtimes.jdks)
      setHotswapAgent(runtimes.hotswapAgent)
      setTools(runtimes.tools)
    } catch { say({ text: '개발 도구 목록을 읽지 못했습니다.', error: true }) }
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

  const install = async (agent = false, tool?: ToolBuild) => {
    if (busy || registering || removing || (!agent && !tool && !selectedBuild)) return
    const label = tool ? TOOL_NAMES[tool.tool] ?? '개발 도구' : agent ? 'HotswapAgent' : 'JDK'
    setInstalling(true)
    say(null)
    try {
      const result = tool
        ? await api.runtimesToolInstall(tool.tool, tool.series).then(outcome => outcome.ok ? { ...outcome, version: outcome.tool.version } : outcome)
        : agent
          ? await api.runtimesHotswapInstall().then(outcome => outcome.ok ? { ...outcome, version: null } : outcome)
          : await api.runtimesInstall(vendor, feature).then(outcome => outcome.ok ? { ...outcome, version: outcome.jdk.version } : outcome)
      if (result.ok) {
        say({ text: result.version ? `보관함에 ${label} ${result.version} 설치를 완료했습니다.` : 'HotswapAgent를 보관함에 추가했습니다.' })
        await refresh()
      } else say(result.cancelled ? { text: `${label} 받기를 취소했습니다.` } : { text: result.error ?? `${label}를 받지 못했습니다.`, error: true })
    } catch { say({ text: `${label}를 받지 못했습니다.`, error: true }) }
    finally { setInstalling(false); setCancelling(false) }
  }

  const registerTomcat = async () => {
    if (busy || removing || registering) return
    setRegistering(true)
    say(null)
    try {
      const result = await api.runtimesTomcatRegister()
      if (result.ok) {
        say({ text: `Tomcat ${result.tool.version} 폴더 등록을 완료했습니다.` })
        await refresh()
      } else if (!result.cancelled) say({ text: result.error ?? 'Tomcat 6 폴더를 등록하지 못했습니다.', error: true })
    } catch { say({ text: 'Tomcat 6 폴더를 등록하지 못했습니다.', error: true }) }
    finally { setRegistering(false) }
  }

  const cancel = async () => {
    setCancelling(true)
    try { if (!await api.runtimesCancel()) setCancelling(false) }
    catch { setCancelling(false); say({ text: '받기를 취소하지 못했습니다.', error: true }) }
  }

  const remove = async (id: string, isTool: boolean, name?: string) => {
    if (busy || removing || registering) return
    setRemoving(true)
    say(null)
    const label = isTool ? name ?? '개발 도구' : id === AGENT ? 'HotswapAgent' : `JDK ${name ?? ''}`.trim()
    try {
      const result = isTool ? await api.runtimesToolRemove(id) : id === AGENT ? await api.runtimesHotswapRemove() : await api.runtimesRemove(id)
      if (result.ok) {
        setPendingRemoval(null)
        say({ text: `보관함에서 ${label}를 지웠습니다.` })
        await refresh()
      } else say({ text: result.error, error: true })
    } catch { say({ text: `${label}를 지우지 못했습니다.`, error: true }) }
    finally { setRemoving(false) }
  }

  const removeButtons = (id: string, label: string, apache = false) => pendingRemoval === id ? <span className="devtools-row-actions">
    <button type="button" className="devtools-btn" disabled={removing} onClick={() => setPendingRemoval(null)}>취소</button>
    <button type="button" className="devtools-btn is-danger" disabled={busy || removing || registering} onClick={() => void remove(id, apache, label)}>삭제 확인</button>
  </span> : <button type="button" className="devtools-btn is-quiet" disabled={busy || removing || registering} aria-label={`${label} 지우기`} onClick={() => setPendingRemoval(id)}>지우기</button>

  // One list: what the app keeps (can be removed) and what this PC already has, newest version first
  const sorted = jdks ? [...jdks].sort((a, b) => b.feature - a.feature || Number(b.managed) - Number(a.managed)) : null
  const managedCount = jdks?.filter(jdk => jdk.managed).length ?? 0
  const jbr = jdks?.filter(jdk => jdk.vendor === 'jbr') ?? []
  const openJbr = () => {
    setVendor('jbr')
    if (!JBR_FEATURES.includes(feature)) setFeature(21)
    setExpanded(true)
  }

  return <section className="settings-section jdk-settings devtools">
    {notice?.error && <p className="jdk-error devtools-alert" role="alert">{notice.text}</p>}
    {busy && <div className="jdk-progress devtools-progress">
      <span role="status">{cancelling ? '취소 중…' : progress?.phase === 'unpack' ? '압축 푸는 중…' : progress?.phase === 'download' ? `받는 중 · ${formatBytes(progress.received)}` : '다운로드 확인 중…'}</span>
      <progress aria-label="개발 도구 받기 진행률" max={progress?.total ?? undefined} value={progress?.total ? progress.received : undefined} />
      <button type="button" className="devtools-btn" disabled={cancelling} onClick={() => void cancel()}>받기 취소</button>
    </div>}

    <div className="devtools-card">
      <div className="jdk-heading devtools-card-head">
        <div className="devtools-card-title">
          <h3 className="settings-section-title">JDK</h3>
          <p className="settings-section-desc">실행 구성에서 고를 수 있습니다{jdks ? ` · 받음 ${managedCount}개, 이 PC ${jdks.length - managedCount}개` : ''}</p>
        </div>
        <button type="button" className={`devtools-btn${expanded ? ' is-on' : ''}`} aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
          <RiDownloadLine size={13} aria-hidden="true" />JDK 받기
        </button>
      </div>
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
          <button type="button" className="devtools-btn is-primary" disabled={lookingUp || !selectedBuild || busy || alreadyInstalled || registering || removing} onClick={() => void install()}>
            {alreadyInstalled ? '받음' : '받아 두기'}
          </button>
        </div>
        <div className="devtools-download-note">
          {lookingUp ? <span>공개 빌드를 확인하는 중…</span> : lookupError ? (
            <span role="alert" className="jdk-error">{lookupError} <button type="button" className="devtools-link" onClick={() => setRetry(value => value + 1)}>다시 확인</button></span>
          ) : selectedBuild ? <span>{selectedBuild.version} · {selectedBuild.arch}{selectedBuild.sizeBytes ? ` · ${formatBytes(selectedBuild.sizeBytes)}` : ''}</span>
            : legacy ? <span>JDK {feature}의 공개된 무료 배포가 없습니다.
              {localLegacy && <button type="button" className="devtools-link" onClick={() => {
                document.getElementById(`jdk-${localLegacy.id}`)?.focus()
                toast.info('JDK', `실행 구성에서 ${providerName(localLegacy.vendor)} ${localLegacy.version}을 선택하세요.`)
              }}>이 PC의 JDK {feature} 쓰기</button>}
              <button type="button" className="devtools-link" onClick={() => setFeature(8)}>JDK 8로 받기</button>
            </span>
            : <span>이 버전의 공개 빌드가 없습니다. 이 PC에서 찾은 JDK를 실행 구성에서 선택할 수 있습니다.</span>}
          <button type="button" className="devtools-link" title={selectedBuild?.licenseUrl} onClick={() => void api.runtimesOpenLicense(vendor)}>라이선스 보기</button>
        </div>
      </div>}
      {!sorted ? <p className="devtools-empty">목록 확인 중…</p> : <>
        {sorted.length > 0 && <ul className="jdk-list devtools-list">
          {sorted.map(jdk => {
            const meta = [jdk.arch === 'unknown' ? null : jdk.arch, jdk.folder, jdk.sizeBytes === undefined ? null : formatBytes(jdk.sizeBytes)].filter(Boolean).join(' · ')
            return <li key={jdk.id} id={`jdk-${jdk.id}`} tabIndex={jdk.managed ? undefined : -1}>
              <span className="devtools-badge" aria-hidden="true">{jdk.feature}</span>
              <div className="jdk-item-name">
                <strong>{providerName(jdk.vendor)} {jdk.version}</strong>
                <span title={meta}>{meta}</span>
              </div>
              <span className={`devtools-tag${jdk.managed ? ' is-managed' : ''}`}>{jdk.managed ? '받음' : '이 PC'}</span>
              {jdk.managed ? removeButtons(jdk.id, jdk.version) : <span className="devtools-row-actions" />}
            </li>
          })}
        </ul>}
        {managedCount === 0 && <p className="devtools-empty">받은 JDK가 없습니다. 필요한 버전은 JDK 받기로 받아 둘 수 있습니다.</p>}
      </>}
    </div>

    <div className="devtools-card">
      <div className="devtools-card-head">
        <div className="devtools-card-title">
          <h3 className="settings-section-title">확장 바로 반영</h3>
          <p className="settings-section-desc">JetBrains Runtime 17·21과 HotswapAgent가 있으면, 메서드·필드 추가도 재기동 없이 반영합니다.</p>
        </div>
      </div>
      <ul className="devtools-list">
        <li>
          <span className="devtools-badge is-icon" aria-hidden="true"><RiCupLine size={15} /></span>
          <div className="jdk-item-name">
            <strong>JetBrains Runtime</strong>
            <span>{jbr.length ? jbr.map(jdk => jdk.version).join(', ') : 'JDK 받기에서 공급자를 JetBrains Runtime으로 고릅니다'}</span>
          </div>
          <span className={`devtools-tag${jbr.length ? ' is-managed' : ''}`}>{jbr.length ? '있음' : '없음'}</span>
          <span className="devtools-row-actions">{!jbr.length && <button type="button" className="devtools-btn" onClick={openJbr}>JBR 받기</button>}</span>
        </li>
        <li>
          <span className="devtools-badge is-icon" aria-hidden="true"><RiFlashlightLine size={15} /></span>
          <div className="jdk-item-name">
            <strong>HotswapAgent{hotswapAgent?.installed && hotswapAgent.version ? ` ${hotswapAgent.version}` : ''}</strong>
            <span><button type="button" className="devtools-link" onClick={() => void api.runtimesOpenLicense(AGENT)}>HotswapAgent 라이선스</button></span>
          </div>
          <span className={`devtools-tag${hotswapAgent?.installed ? ' is-managed' : ''}`}>{hotswapAgent?.installed ? '받음' : '없음'}</span>
          {hotswapAgent?.installed ? removeButtons(AGENT, 'HotswapAgent')
            : <button type="button" className="devtools-btn is-primary" disabled={!hotswapAgent || busy || removing || registering} onClick={() => void install(true)}>HotswapAgent 받기</button>}
        </li>
      </ul>
    </div>

    <ApacheToolSettings tools={tools} busy={busy || removing || registering} onInstall={build => void install(false, build)}
      onRegisterTomcat={registerTomcat} removeButtons={(id, label) => removeButtons(id, label, true)} />
  </section>
}
