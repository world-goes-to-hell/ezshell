import { useCallback, useRef, useState } from 'react'
import { RiCheckboxCircleFill, RiErrorWarningFill, RiLoader4Line } from 'react-icons/ri'
import { toSSHConnectConfig } from '../../lib/sshConnectConfig'
import type { SshConnectionTestResult } from '../../types'
import type { ConnectionConfig } from './ConnectModal'
import './ConnectionTest.css'

export type ConnectionTestState =
  | { status: 'idle' }
  | { status: 'testing' }
  | { status: 'done'; result: SshConnectionTestResult }

const IDLE: ConnectionTestState = { status: 'idle' }

/**
 * Runs a one-shot SSH login with the modal's current input.
 * Results from an older run (or after `reset`) are dropped, so edits never show a stale verdict.
 */
export function useConnectionTest() {
  const [state, setState] = useState<ConnectionTestState>(IDLE)
  const runIdRef = useRef(0)

  const reset = useCallback(() => {
    runIdRef.current += 1
    setState(IDLE)
  }, [])

  const run = useCallback(async (config: ConnectionConfig) => {
    const runId = ++runIdRef.current
    setState({ status: 'testing' })
    let result: SshConnectionTestResult
    // The preload bridge only picks up new APIs after an app restart
    if (typeof window.electronAPI?.sshTestConnection !== 'function') {
      if (runIdRef.current === runId) {
        setState({ status: 'done', result: { success: false, stage: 'target', error: '앱을 다시 시작한 뒤 연결 테스트를 사용할 수 있습니다.' } })
      }
      return
    }
    try {
      const { sessionName, color, postConnectScript, savedSessionId, ...connectConfig } = toSSHConnectConfig(config)
      result = await window.electronAPI.sshTestConnection(connectConfig)
    } catch (error) {
      result = {
        success: false,
        stage: 'target',
        error: '연결 테스트를 실행하지 못했습니다.',
        detail: error instanceof Error ? error.message : String(error)
      }
    }
    if (runIdRef.current === runId) setState({ status: 'done', result })
  }, [])

  return { state, run, reset }
}

const formatElapsed = (ms: number) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}초`)

export function ConnectionTestStatus({ state }: { state: ConnectionTestState }) {
  if (state.status === 'idle') return null

  if (state.status === 'testing') {
    return (
      <div className="connection-test-status is-testing" role="status" aria-live="polite">
        <RiLoader4Line size={16} className="connection-test-spin" />
        <span>서버에 접속해 인증을 확인하는 중입니다...</span>
      </div>
    )
  }

  const { result } = state
  if (result.success) {
    return (
      <div className="connection-test-status is-success" role="status" aria-live="polite">
        <RiCheckboxCircleFill size={16} />
        <span>
          연결에 성공했습니다. ({formatElapsed(result.elapsedMs)}{result.viaJumpHost ? ', Jump Host 경유' : ''})
        </span>
      </div>
    )
  }

  return (
    <div className="connection-test-status is-error" role="alert">
      <RiErrorWarningFill size={16} />
      <div className="connection-test-body">
        <span>{result.stage === 'jump' ? '[Jump Host] ' : ''}{result.error}</span>
        {result.hint && <span className="connection-test-hint">{result.hint}</span>}
        {result.detail && <code className="connection-test-detail">{result.detail}</code>}
      </div>
    </div>
  )
}
