// The fields of a Tomcat run preset in the add / edit dialog (docs/plan/2026-11-25-local-project-run.md,
// stage 2 first batch): which Tomcat, the web folder with WEB-INF, the context path and port, the VM
// arguments and the build before the server. main makes a CATALINA_BASE of its own for the preset; the VM
// arguments and the build are shown and confirmed before they first run, like a typed command.
// `이클립스 설정에서 채우기` (second batch) fills the web folder and context path from the Eclipse project's
// settings and shows what else it read; the user saves. Third batch: a server of an Eclipse workspace fills
// the VM arguments, port, context and its context.xml; the context.xml (JNDI) is pointed at, never copied
// into the preset; jars approved from a diagnosis are listed and can only be taken away here.
import { useEffect, useState } from 'react'
import { RiCloseLine, RiDownloadLine, RiFileCodeLine, RiFolder3Line, RiServerLine } from 'react-icons/ri'
import { eclipseFill, eclipseSummary, shortPath, workspaceServerFill, type PresetDraft } from '../../lib/runPresets'
import type { WorkspaceServer } from '../../types'
import { runPresetApi } from '../../stores/runPresetStore'
import type { ApacheToolRuntime } from '../../types'
import './RunPresetTomcat.css'

export const tomcatLabel = (tool: ApacheToolRuntime) =>
  [`Tomcat ${tool.version ?? tool.series ?? '(버전 모름)'}`, tool.managed ? '' : '· 이 PC'].filter(Boolean).join(' ')

export function RunPresetTomcatFields({ folder, relative, draft, set, tomcats, onToSettings }: {
  /** The worktree */
  folder: string
  /** Where the build runs (the preset's folder) */
  relative: string
  draft: PresetDraft
  set: (patch: Partial<PresetDraft>) => void
  /** The store's and found Tomcats; null while the list loads */
  tomcats: ApacheToolRuntime[] | null
  onToSettings: () => void
}) {
  const [webapps, setWebapps] = useState<string[]>([])
  // The build.xml's targets in the preset's folder: null while asked, [] when there are none
  const [targets, setTargets] = useState<string[] | null>(null)
  const [targetsError, setTargetsError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    void runPresetApi().runPresetWebapps?.(folder).then(result => {
      if (active && Array.isArray(result?.folders)) setWebapps(result.folders.filter(item => typeof item === 'string'))
    }).catch(() => {})
    return () => { active = false }
  }, [folder])

  const wantsAnt = draft.prepareTool === 'ant'
  useEffect(() => {
    if (!wantsAnt) return
    const ask = runPresetApi().runPresetAntTargets
    if (!ask) { setTargets([]); return }
    let active = true
    setTargets(null)
    setTargetsError(null)
    const timer = window.setTimeout(() => {
      ask(folder, relative).then(result => {
        if (!active) return
        const list = Array.isArray(result?.targets) ? result.targets.filter(item => typeof item === 'string') : []
        setTargets(list)
        if (result?.ok === false && result.error) setTargetsError(result.error)
      }, () => { if (active) setTargets([]) })
    }, 300)
    return () => { active = false; window.clearTimeout(timer) }
  }, [folder, relative, wantsAnt])

  // The Eclipse project's settings, read when asked: what was read, or why not
  const [eclipse, setEclipse] = useState<{ lines: string[] } | { error: string } | null>(null)
  const [reading, setReading] = useState(false)
  const canImport = typeof runPresetApi().runPresetEclipseImport === 'function'
  const importEclipse = async () => {
    const read = runPresetApi().runPresetEclipseImport
    if (!read || reading) return
    setReading(true)
    try {
      const result = await read(folder, relative)
      if (result?.ok === false || !result?.draft) {
        setEclipse({ error: result?.error || '이클립스 설정을 읽지 못했습니다.' })
        return
      }
      const imported = { ...result.draft, sources: Array.isArray(result.draft.sources) ? result.draft.sources : [], libs: Array.isArray(result.draft.libs) ? result.draft.libs : [] }
      set(eclipseFill(imported, relative))
      setEclipse({ lines: eclipseSummary(imported, Array.isArray(result.notes) ? result.notes : []) })
    } catch {
      setEclipse({ error: '이클립스 설정을 읽지 못했습니다.' })
    } finally {
      setReading(false)
    }
  }

  // The servers of an Eclipse workspace the user picked: to choose one from
  const [workspace, setWorkspace] = useState<{ name: string; servers: WorkspaceServer[] } | { error: string } | null>(null)
  const [filledFrom, setFilledFrom] = useState<string | null>(null)
  const [contextError, setContextError] = useState<string | null>(null)
  const canWorkspace = typeof window.electronAPI.runPresetWorkspaceServers === 'function'
  const readWorkspace = async () => {
    const read = window.electronAPI.runPresetWorkspaceServers
    if (!read || reading) return
    setReading(true)
    try {
      const result = await read(folder)
      if (result?.cancelled) return
      if (result?.ok === false) { setWorkspace({ error: result.error || '워크스페이스를 읽지 못했습니다.' }); return }
      const servers = Array.isArray(result?.servers) ? result.servers.filter(server => server && typeof server.name === 'string') : []
      setWorkspace(servers.length ? { name: result.workspace || '워크스페이스', servers } : { error: '이 워크스페이스에서 Tomcat 서버 설정을 찾지 못했습니다 (Servers 폴더).' })
      setFilledFrom(null)
    } catch {
      setWorkspace({ error: '워크스페이스를 읽지 못했습니다.' })
    } finally {
      setReading(false)
    }
  }
  const chooseServer = (server: WorkspaceServer) => {
    set(workspaceServerFill(server))
    setFilledFrom(server.name)
  }
  const chooseContextXml = async () => {
    const choose = window.electronAPI.runPresetChooseContextXml
    if (!choose) return
    try {
      const result = await choose(folder)
      setContextError(null)
      if (result?.ok && result.contextXml) set({ contextXml: result.contextXml, contextXmlLabel: result.label })
      else if (result?.ok === false && !result.cancelled) setContextError(result.error || 'context.xml 을 고르지 못했습니다.')
    } catch { /* nothing chosen */ }
  }

  const known = tomcats?.some(tool => tool.id === draft.tomcat)
  return (
    <div className="run-preset-tomcat">
      {canImport && (
        <div className="run-preset-eclipse">
          <button type="button" className="run-preset-eclipse-btn" onClick={() => void importEclipse()} disabled={reading}>
            <RiDownloadLine size={13} aria-hidden="true" /> {reading ? '읽는 중…' : '이클립스 설정에서 채우기'}
          </button>
          <span className="run-preset-hint">{relative === '.' ? '프로젝트 폴더' : relative}의 .classpath·.settings 를 읽어 웹 폴더와 컨텍스트 경로를 채웁니다. 저장해야 반영됩니다.</span>
          {eclipse && ('error' in eclipse
            ? <p className="run-preset-warn" role="alert">{eclipse.error}</p>
            : <ul className="run-preset-eclipse-read" aria-label="이클립스 설정에서 읽은 것">
                {eclipse.lines.map((line, index) => <li key={index}>{line}</li>)}
              </ul>)}
        </div>
      )}
      {canWorkspace && (
        <div className="run-preset-eclipse run-preset-workspace">
          <button type="button" className="run-preset-eclipse-btn" onClick={() => void readWorkspace()} disabled={reading}>
            <RiServerLine size={13} aria-hidden="true" /> 워크스페이스 서버 설정에서 채우기
          </button>
          <span className="run-preset-hint">이클립스 워크스페이스 폴더를 고르면 Servers 의 server.xml·context.xml 과 실행 설정의 VM 인자를 읽습니다. 저장해야 반영됩니다.</span>
          {workspace && ('error' in workspace
            ? <p className="run-preset-warn" role="alert">{workspace.error}</p>
            : (
              <div className="run-preset-servers" role="radiogroup" aria-label={`${workspace.name} 의 서버`}>
                {workspace.servers.map(server => (
                  <label key={server.name} className="run-preset-server" data-on={filledFrom === server.name || undefined}>
                    <input type="radio" name="run-preset-server" checked={filledFrom === server.name} onChange={() => chooseServer(server)} />
                    <span>
                      <strong>{server.name}</strong>
                      <small>{[server.port && `포트 ${server.port}`, server.contextPath && `경로 ${server.contextPath}`, server.vmArgs && 'VM 인자', server.contextXml && 'context.xml'].filter(Boolean).join(' · ') || '읽은 값 없음'}</small>
                    </span>
                  </label>
                ))}
                {filledFrom && <small className="run-preset-hint">{filledFrom} 의 값으로 채웠습니다. 아래 칸에서 확인하고 저장하세요.</small>}
              </div>
            ))}
        </div>
      )}
      <div className="form-group">
        <label htmlFor="run-preset-tomcat">Tomcat</label>
        {tomcats !== null && tomcats.length === 0 ? (
          <div className="run-preset-reload-missing" data-selected>
            <small>받거나 찾은 Tomcat 이 없습니다.</small>
            <button type="button" className="run-preset-link" onClick={onToSettings}>설정 &gt; 개발 도구에서 받기</button>
          </div>
        ) : (
          <select id="run-preset-tomcat" value={draft.tomcat} onChange={event => set({ tomcat: event.target.value })}>
            {!draft.tomcat && <option value="">{tomcats === null ? '찾는 중…' : 'Tomcat 고르기'}</option>}
            {tomcats?.map(tool => <option key={tool.id} value={tool.id}>{tomcatLabel(tool)}</option>)}
            {draft.tomcat && tomcats !== null && !known && <option value={draft.tomcat}>{draft.tomcat} (보관함에 없음)</option>}
          </select>
        )}
      </div>
      <div className="form-group">
        <label htmlFor="run-preset-webapp">웹 폴더 <span className="run-preset-hint">(WEB-INF 가 든 폴더)</span></label>
        <div className="run-preset-folder-input">
          <RiFolder3Line size={13} aria-hidden="true" />
          <input id="run-preset-webapp" list="run-preset-webapps" value={draft.webapp} placeholder="예: WebContent, src/main/webapp"
            onChange={event => set({ webapp: event.target.value })} spellCheck={false} autoComplete="off" />
          <datalist id="run-preset-webapps">
            {webapps.map(name => <option key={name} value={name} />)}
          </datalist>
        </div>
      </div>
      <div className="run-preset-tomcat-row">
        <div className="form-group">
          <label htmlFor="run-preset-context">컨텍스트 경로</label>
          <input id="run-preset-context" value={draft.contextPath} placeholder="/" maxLength={65}
            onChange={event => set({ contextPath: event.target.value })} spellCheck={false} autoComplete="off" />
        </div>
        <div className="form-group">
          <label htmlFor="run-preset-port">포트</label>
          <input id="run-preset-port" inputMode="numeric" value={draft.portText} placeholder="8080" maxLength={5}
            onChange={event => set({ portText: event.target.value.replace(/[^0-9]/g, '') })} autoComplete="off" />
        </div>
      </div>
      {/* main opens the HTTP connector on the loopback only (src/ipc/tomcatRun.js) */}
      <small className="run-preset-hint run-preset-tomcat-local">이 PC 에서만 열립니다 (http://127.0.0.1:{draft.portText || '8080'}{draft.contextPath.trim() || '/'}).</small>
      <div className="form-group">
        <label htmlFor="run-preset-vmargs">VM 인자 <span className="run-preset-hint">(한 줄, CATALINA_OPTS)</span></label>
        <input id="run-preset-vmargs" className="run-preset-command" value={draft.vmArgs} placeholder="예: -Xmx1g -Dspring.profiles.active=local"
          onChange={event => set({ vmArgs: event.target.value })} spellCheck={false} autoComplete="off" />
      </div>
      <div className="form-group">
        <span className="run-preset-field-label">컨텍스트 설정 파일 <span className="run-preset-hint">(JNDI 데이터소스용 context.xml)</span></span>
        <div className="run-preset-context-xml">
          <RiFileCodeLine size={13} aria-hidden="true" />
          <span className="run-preset-context-xml-path" title={draft.contextXml || undefined}>
            {draft.contextXml ? (draft.contextXmlLabel || shortPath(draft.contextXml)) : '없음'}
          </span>
          {typeof window.electronAPI.runPresetChooseContextXml === 'function' && (
            <button type="button" className="run-preset-link" onClick={() => void chooseContextXml()}>{draft.contextXml ? '바꾸기' : '고르기'}</button>
          )}
          {draft.contextXml && (
            <button type="button" className="run-preset-link" onClick={() => set({ contextXml: '', contextXmlLabel: undefined })}>비우기</button>
          )}
        </div>
        {contextError && <small className="run-preset-warn" role="alert">{contextError}</small>}
        <small className="run-preset-hint">파일을 가리키기만 합니다. 비밀번호는 저장하지 않고 실행 때 원본에서 읽습니다.</small>
      </div>
      {draft.extraLibs.length > 0 && (
        <div className="form-group">
          <span className="run-preset-field-label">추가 lib <span className="run-preset-hint">(실행 진단에서 승인한 jar, /WEB-INF/lib 로 붙임)</span></span>
          <ul className="run-preset-extra-libs">
            {draft.extraLibs.map(jar => (
              <li key={jar}>
                <code title={jar}>{shortPath(jar)}</code>
                <button type="button" className="run-preset-extra-lib-remove" aria-label={`${shortPath(jar)} 빼기`} title="빼기"
                  onClick={() => set({ extraLibs: draft.extraLibs.filter(item => item !== jar) })}>
                  <RiCloseLine size={13} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
          <small className="run-preset-hint">더하는 것은 실행 진단에서만 합니다.</small>
        </div>
      )}
      <div className="form-group" role="radiogroup" aria-label="기동 전 빌드">
        <span className="run-preset-field-label">기동 전 빌드 <span className="run-preset-hint">({relative === '.' ? '프로젝트 폴더' : relative}에서)</span></span>
        <div className="run-preset-reload-options run-preset-prepare-options">
          {([['none', '없음'], ['ant', 'Ant 타깃'], ['maven', 'Maven 목표'], ['eclipse', '이클립스식']] as const).map(([value, label]) => (
            <label key={value} className="run-preset-reload-option" data-on={draft.prepareTool === value || undefined}>
              <input type="radio" name="run-preset-prepare" value={value} checked={draft.prepareTool === value}
                onChange={() => set({ prepareTool: value })} />
              <strong>{label}</strong>
            </label>
          ))}
        </div>
        {draft.prepareTool === 'ant' && (
          targets !== null && targets.length === 0 ? (
            <small className="run-preset-warn">{targetsError ?? '이 폴더의 build.xml 에서 타깃을 찾지 못했습니다. 폴더를 확인해 주세요.'}</small>
          ) : (
            <select aria-label="Ant 타깃" value={draft.antTarget} onChange={event => set({ antTarget: event.target.value })}>
              {!draft.antTarget && <option value="">{targets === null ? '찾는 중…' : '타깃 고르기'}</option>}
              {targets?.map(target => <option key={target} value={target}>{target}</option>)}
              {draft.antTarget && targets !== null && !targets.includes(draft.antTarget) && <option value={draft.antTarget}>{draft.antTarget} (build.xml 에 없음)</option>}
            </select>
          )
        )}
        {draft.prepareTool === 'eclipse' && (
          <small className="run-preset-hint run-preset-prepare-note">build.xml 없이 이클립스 설정(.classpath 의 소스·lib)으로 javac 컴파일합니다. 결과는 프로젝트가 아니라 앱 폴더에 둡니다.</small>
        )}
        {draft.prepareTool === 'maven' && (
          <input className="run-preset-command" aria-label="Maven 목표" value={draft.mavenGoals} placeholder="예: clean package"
            onChange={event => set({ mavenGoals: event.target.value })} spellCheck={false} autoComplete="off" />
        )}
      </div>
      {(draft.vmArgs.trim() || draft.prepareTool !== 'none' || draft.contextXml || draft.extraLibs.length > 0) && (
        <small className="run-preset-warn">VM 인자·기동 전 빌드·컨텍스트 설정 파일·추가 lib 은 실행 내용입니다. 처음 실행할 때와 바뀐 뒤에 한 번 더 확인합니다.</small>
      )}
    </div>
  )
}
