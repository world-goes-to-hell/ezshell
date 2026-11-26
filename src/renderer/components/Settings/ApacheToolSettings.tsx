import { useEffect, useState, type ReactNode } from 'react'
import { formatBytes } from '../../lib/mcpLabels'
import type { ApacheTool, ApacheToolBuild, ApacheToolRuntime } from '../../types'

const APACHE_TOOLS = {
  tomcat: { name: 'Tomcat', series: ['11', '10.1', '9', '8.5', '7', '6'] },
  maven: { name: 'Maven', series: ['3.9', '3.8', '3.6'] },
  ant: { name: 'Ant', series: ['1.10', '1.9'] }
}

interface Props {
  tools: ApacheToolRuntime[] | null
  busy: boolean
  onInstall: (build: ApacheToolBuild) => void
  onRegisterTomcat: () => Promise<void>
  removeButtons: (id: string, label: string) => ReactNode
}

export function ApacheToolSettings({ tools, busy, onInstall, onRegisterTomcat, removeButtons }: Props) {
  const api = window.electronAPI
  const [expanded, setExpanded] = useState(false)
  const [tool, setTool] = useState<ApacheTool>('tomcat')
  const [series, setSeries] = useState('11')
  const [build, setBuild] = useState<ApacheToolBuild | null>(null)
  const [lookingUp, setLookingUp] = useState(false)
  const [lookupError, setLookupError] = useState('')
  const [retry, setRetry] = useState(0)
  const tomcat6 = tool === 'tomcat' && series === '6'
  const option = APACHE_TOOLS[tool]
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
      if (current) setLookupError('Apache 배포본을 확인하지 못했습니다.')
    }).finally(() => {
      if (current) setLookingUp(false)
    })
    return () => { current = false }
  }, [api, expanded, tool, series, tomcat6, retry])

  return <section className="jdk-list-section apache-tools">
    <div className="jdk-heading">
      <h3 className="settings-section-title">Apache 도구</h3>
      <button type="button" className="btn-secondary" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>Apache 도구 받기</button>
    </div>
    {expanded && <div className="jdk-download">
      <div className="jdk-choice-row">
        <label>도구<select value={tool} disabled={busy} onChange={event => {
          const next = event.target.value as ApacheTool
          setTool(next)
          setSeries(APACHE_TOOLS[next].series[0])
        }}>
          {Object.entries(APACHE_TOOLS).map(([id, value]) => <option key={id} value={id}>{value.name}</option>)}
        </select></label>
        <label>버전<select value={series} disabled={busy} onChange={event => setSeries(event.target.value)}>
          {option.series.map(value => <option key={value} value={value}>{value}</option>)}
        </select></label>
      </div>
      <div className="jdk-actions">
        <button type="button" className="btn-secondary" title={selected?.licenseUrl} onClick={() => void api.runtimesOpenLicense(tool)}>Apache 라이선스 보기</button>
        {tomcat6 ? <>
          <button type="button" className="btn-secondary" disabled={busy} onClick={() => void onRegisterTomcat()}>Tomcat 6 폴더 등록</button>
          <button type="button" className="btn-secondary" disabled={busy} onClick={() => setSeries('7')}>Tomcat 7 받기</button>
        </> : <button type="button" className="btn-primary" disabled={lookingUp || !selected || installed || busy}
          onClick={() => selected && onInstall(selected)}>{installed ? '받음' : '도구 받아 두기'}</button>}
      </div>
      {tomcat6 ? <>
        <p className="settings-section-desc">Tomcat 6 공식 배포본에는 SHA-512가 없어 자동으로 받을 수 없습니다. 이 PC의 설치 폴더를 등록하거나 Tomcat 7을 받을 수 있습니다.</p>
        {foundTomcat6 && <p className="settings-section-desc">찾은 Tomcat 6을 실행 구성에서 선택할 수 있습니다.</p>}
      </> : lookingUp ? <p className="settings-section-desc" role="status">배포본 확인 중…</p>
        : lookupError ? <div className="jdk-actions" role="alert"><span>{lookupError}</span><button type="button" className="btn-secondary" onClick={() => setRetry(value => value + 1)}>다시 확인</button></div>
        : selected ? <p className="settings-section-desc">{option.name} {selected.version}</p>
        : <p className="settings-section-desc">현재 플랫폼에 맞는 공개 배포본이 없습니다.</p>}
    </div>}
    {!tools ? <p className="settings-section-desc">목록 확인 중…</p> : tools.length === 0 ? <p className="settings-section-desc">받았거나 찾은 Apache 도구가 없습니다.</p> : <ul className="jdk-list">
      {tools.map(item => {
        const name = [APACHE_TOOLS[item.tool].name, item.version].filter(Boolean).join(' ')
        return <li key={item.id}>
          <div className="jdk-item-name">
            <strong>{name}</strong>
            <span>{[item.managed ? '받음' : '찾은 것', item.folder, item.sizeBytes === undefined ? null : formatBytes(item.sizeBytes)].filter(Boolean).join(' · ')}</span>
          </div>
          {item.managed && removeButtons(item.id, name)}
        </li>
      })}
    </ul>}
  </section>
}
