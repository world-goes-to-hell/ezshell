// 설정 > 진단 정보 (docs/plan/2026-11-28-diagnostics.md): the recent error count, the bundle folded for a look, and
// 복사 · 파일로 저장 · 로그 폴더 열기. The bundle is built by main when this opens and on 다시 만들기.
import { useCallback, useEffect, useState } from 'react'
import { RiFileCopyLine, RiFolderOpenLine, RiRefreshLine, RiSave3Line, RiStethoscopeLine } from 'react-icons/ri'
import { errorsLabel, openDiagnosticsLogs, readDiagnostics, saveDiagnostics } from '../../lib/diagnostics'
import { copyToClipboard } from '../../lib/terminalClipboard'
import './DiagnosticsSettings.css'

type Report = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; text: string; errors: number }

export function DiagnosticsSettings() {
  const [report, setReport] = useState<Report>({ status: 'loading' })
  const load = useCallback(async () => {
    setReport({ status: 'loading' })
    const result = await readDiagnostics()
    setReport('error' in result ? { status: 'error', message: result.error } : { status: 'ready', ...result })
  }, [])
  useEffect(() => { void load() }, [load])

  return (
    <section className="settings-section diagnostics-settings">
      <h3 className="settings-section-title">
        <RiStethoscopeLine size={18} />
        진단 정보
      </h3>
      <p className="settings-section-desc">
        버그를 알릴 때 붙일 정보입니다: 앱·Electron·OS·Claude Code·Codex 버전, 에이전트 상태, 최근 오류.
        메시지 내용·프롬프트·비밀 값은 담지 않고 홈 폴더는 <code>~</code> 로 줄입니다.
      </p>
      <div className="diagnostics-summary" data-errors={report.status === 'ready' && report.errors > 0 || undefined} role="status">
        {report.status === 'loading' ? '진단 정보를 만드는 중…'
          : report.status === 'error' ? report.message
          : errorsLabel(report.errors)}
      </div>
      <div className="diagnostics-actions">
        <button type="button" className="btn-secondary" disabled={report.status !== 'ready'}
          onClick={() => { if (report.status === 'ready') void copyToClipboard(report.text) }}>
          <RiFileCopyLine size={14} aria-hidden="true" /> 복사
        </button>
        <button type="button" className="btn-secondary" onClick={() => void saveDiagnostics()}>
          <RiSave3Line size={14} aria-hidden="true" /> 파일로 저장
        </button>
        <button type="button" className="btn-secondary" onClick={() => void openDiagnosticsLogs()}>
          <RiFolderOpenLine size={14} aria-hidden="true" /> 로그 폴더 열기
        </button>
        <button type="button" className="btn-secondary" disabled={report.status === 'loading'} onClick={() => void load()} title="지금 상태로 다시 만들기">
          <RiRefreshLine size={14} aria-hidden="true" /> 다시 만들기
        </button>
      </div>
      {report.status === 'ready' && (
        <details className="diagnostics-preview">
          <summary>미리보기</summary>
          <pre>{report.text}</pre>
        </details>
      )}
    </section>
  )
}
