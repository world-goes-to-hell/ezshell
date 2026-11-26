import { useEffect, useState, type ReactNode } from 'react'
import { RiDownloadLine } from 'react-icons/ri'
import { formatBytes } from '../../lib/mcpLabels'
import type { DevelopmentTool, ToolBuild, ToolRuntime } from '../../types'

const TOOLS = {
  tomcat: { name: 'Tomcat', series: ['11', '10.1', '9', '8.5', '7', '6'] },
  maven: { name: 'Maven', series: ['3.9', '3.8', '3.6'] },
  ant: { name: 'Ant', series: ['1.10', '1.9'] },
  gradle: { name: 'Gradle', series: ['current'] },
  node: { name: 'Node.js', series: ['lts'] }
}

interface Props {
  tools: ToolRuntime[] | null
  busy: boolean
  onInstall: (build: ToolBuild) => void
  onRegisterTomcat: () => Promise<void>
  removeButtons: (id: string, label: string) => ReactNode
}

export function ApacheToolSettings({ tools, busy, onInstall, onRegisterTomcat, removeButtons }: Props) {
  const api = window.electronAPI
  const [expanded, setExpanded] = useState(false)
  const [tool, setTool] = useState<DevelopmentTool>('tomcat')
  const [series, setSeries] = useState('11')
  const [build, setBuild] = useState<ToolBuild | null>(null)
  const [lookingUp, setLookingUp] = useState(false)
  const [lookupError, setLookupError] = useState('')
  const [retry, setRetry] = useState(0)
  const tomcat6 = tool === 'tomcat' && series === '6'
  const option = TOOLS[tool]
  const selected = build?.tool === tool && build.series === series ? build : null
  const installed = tools?.some(item => item.managed && item.id === selected?.id)
  const foundTomcat6 = tools?.some(item => !item.managed && item.tool === 'tomcat' && item.series === '6')

  useEffect(() => {
    setBuild(null)
    setLookupError('')
    if (!expanded || tomcat6) { setLookingUp(false); return }
    let current = true
    setLookingUp(true)
    void api.runtimesToolAvailable(tool, series).then(result => {
      if (!current) return
      setBuild(result.tool)
      setLookupError(result.error ?? '')
    }).catch(() => {
      if (current) setLookupError('개발 도구 배포본을 확인하지 못했습니다.')
    }).finally(() => {
      if (current) setLookingUp(false)
    })
    return () => { current = false }
  }, [api, expanded, tool, series, tomcat6, retry])

  // The version's first number, as the JDK rows show theirs (a found Node.js may not tell its version)
  const major = (version: string | null | undefined) => version?.match(/^\d+/)?.[0] ?? '–'
  return <div className="devtools-card apache-tools">
    <div className="jdk-heading devtools-card-head">
      <div className="devtools-card-title">
        <h3 className="settings-section-title">빌드·실행 도구</h3>
        <p className="settings-section-desc">Tomcat·Maven·Ant·Gradle·Node.js{tools ? ` · 받음 ${tools.filter(item => item.managed).length}개, 이 PC ${tools.filter(item => !item.managed).length}개` : ''}</p>
      </div>
      <button type="button" className={`devtools-btn${expanded ? ' is-on' : ''}`} aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
        <RiDownloadLine size={13} aria-hidden="true" />개발 도구 받기
      </button>
    </div>
    {expanded && <div className="jdk-download">
      <div className="jdk-choice-row">
        <label>도구<select value={tool} disabled={busy} onChange={event => {
          const next = event.target.value as DevelopmentTool
          setTool(next)
          setSeries(TOOLS[next].series[0])
        }}>
          {Object.entries(TOOLS).map(([id, value]) => <option key={id} value={id}>{value.name}</option>)}
        </select></label>
        <label>버전<select value={series} disabled={busy} onChange={event => setSeries(event.target.value)}>
          {option.series.map(value => <option key={value} value={value}>{value === 'current' ? '최신 안정 버전' : value === 'lts' ? '최신 LTS' : value}</option>)}
        </select></label>
        {tomcat6 ? <>
          <button type="button" className="devtools-btn" disabled={busy} onClick={() => void onRegisterTomcat()}>Tomcat 6 폴더 등록</button>
          <button type="button" className="devtools-btn" disabled={busy} onClick={() => setSeries('7')}>Tomcat 7 받기</button>
        </> : <button type="button" className="devtools-btn is-primary" disabled={lookingUp || !selected || installed || busy}
          onClick={() => selected && onInstall(selected)}>{installed ? '받음' : '도구 받아 두기'}</button>}
      </div>
      <div className="devtools-download-note">
        {tomcat6 ? <span>Tomcat 6 공식 배포본에는 SHA-512가 없어 자동으로 받을 수 없습니다. 이 PC의 설치 폴더를 등록하거나 Tomcat 7을 받을 수 있습니다.
          {foundTomcat6 && ' 찾은 Tomcat 6을 실행 구성에서 선택할 수 있습니다.'}</span>
          : lookingUp ? <span role="status">배포본 확인 중…</span>
          : lookupError ? <span role="alert" className="jdk-error">{lookupError} <button type="button" className="devtools-link" onClick={() => setRetry(value => value + 1)}>다시 확인</button></span>
          : selected ? <span>받을 버전: {option.name} {selected.version}</span>
          : <span>현재 플랫폼에 맞는 공개 배포본이 없습니다.</span>}
        <button type="button" className="devtools-link" title={selected?.licenseUrl} onClick={() => void api.runtimesOpenLicense(tool)}>{tool === 'gradle' || tool === 'node' ? `${option.name} 라이선스 보기` : 'Apache 라이선스 보기'}</button>
      </div>
    </div>}
    {!tools ? <p className="devtools-empty">목록 확인 중…</p> : tools.length === 0 ? <p className="devtools-empty">받았거나 찾은 빌드·실행 도구가 없습니다.</p> : <ul className="jdk-list devtools-list">
      {tools.map(item => {
        const name = [TOOLS[item.tool].name, item.version].filter(Boolean).join(' ')
        const meta = [item.folder, item.sizeBytes === undefined ? null : formatBytes(item.sizeBytes)].filter(Boolean).join(' · ')
        return <li key={item.id}>
          <span className="devtools-badge" aria-hidden="true">{major(item.version)}</span>
          <div className="jdk-item-name">
            <strong>{name}</strong>
            <span title={meta}>{meta}</span>
          </div>
          <span className={`devtools-tag${item.managed ? ' is-managed' : ''}`}>{item.managed ? '받음' : '이 PC'}</span>
          {item.managed ? removeButtons(item.id, name) : <span className="devtools-row-actions" />}
        </li>
      })}
    </ul>}
  </div>
}
