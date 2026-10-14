// Host key check around one connection attempt. ssh2 calls hostVerifier during the handshake; waiting there
// for a person would run into readyTimeout and the server's LoginGraceTime, so a key that is not saved
// fails the attempt at once, the caller is asked afterwards, and a trusted key leads to a fresh attempt.

const DEFAULT_MAX_PROMPTS = 3

class HostKeyError extends Error {
  /** reason: 'unknown' | 'changed' (refused without asking), 'rejected' (the user declined), 'unsaved' (trusted but not saved) */
  constructor(reason, info) {
    super(`Host key ${reason}: ${info.host}:${info.port}`)
    this.name = 'HostKeyError'
    this.reason = reason
    this.info = info
  }
}

/** What the prompt may show: no key bytes, nothing the renderer could send back to be saved */
function publicInfo(refused) {
  const info = { status: refused.status, host: refused.host, port: refused.port, keyType: refused.keyType, fingerprint: refused.fingerprint }
  return refused.previous ? { ...info, previous: refused.previous } : info
}

/**
 * Run `attempt(verifierFor)`, where `verifierFor(host, port)` gives the ssh2 `hostVerifier` for that server.
 * A key that is not saved fails the attempt. With `prompt(info) → 'trust' | 'reject'` the user is asked and a
 * trusted key is saved before trying again; without it a HostKeyError is thrown. Other errors pass through.
 */
async function withHostKeyCheck({ store, prompt, maxPrompts = DEFAULT_MAX_PROMPTS }, attempt) {
  for (let asked = 0; ; asked += 1) {
    let refused = null
    const verifierFor = (host, rawPort) => {
      const port = Number(rawPort) || 22
      return (key) => {
        const result = store.check(host, port, key)
        if (result.status === 'trusted') return true
        if (!refused) refused = { ...result, host, port, key }
        return false
      }
    }

    let result
    let failure = null
    try {
      result = await attempt(verifierFor)
    } catch (err) {
      failure = err
    }
    if (!refused) {
      if (failure) throw failure
      return result
    }

    const info = publicInfo(refused)
    if (!prompt) throw new HostKeyError(refused.status, info)
    if (asked >= maxPrompts) throw new HostKeyError('rejected', info)
    let decision = 'reject'
    try {
      decision = await prompt(info)
    } catch (err) {
      console.error('Host key prompt failed:', err.message)
    }
    if (decision !== 'trust') throw new HostKeyError('rejected', info)
    try {
      store.trust(refused.host, refused.port, refused.key)
    } catch (err) {
      // Connecting anyway would trust a key that is not on record, so the next connection could not tell a change
      console.error('Failed to save the host key:', err.message)
      throw new HostKeyError('unsaved', info)
    }
  }
}

const isHostKeyError = (err) => err instanceof HostKeyError

/** Korean message for a refused host key; `hint` says what to do next */
function hostKeyMessage(err) {
  const where = `${err.info.host}:${err.info.port}`
  if (err.reason === 'changed') {
    return {
      error: `${where} 서버의 호스트 키가 저장된 키와 다릅니다. 접속하지 않았습니다.`,
      hint: '서버를 다시 설치했거나 키를 바꾼 것이 아니라면 중간에서 가로채는 공격일 수 있습니다. 앱에서 직접 접속해 지문을 확인하세요.'
    }
  }
  if (err.reason === 'unsaved') {
    return {
      error: `${where} 서버의 호스트 키를 저장하지 못해 접속하지 않았습니다.`,
      hint: '앱 데이터 폴더의 known-hosts.json 을 다른 프로그램이 쓰고 있지 않은지, 디스크 공간이 남아 있는지 확인한 뒤 다시 접속하세요.'
    }
  }
  if (err.reason === 'unknown') {
    return {
      error: `${where} 서버의 호스트 키를 아직 확인하지 않아 접속하지 않았습니다.`,
      hint: '앱에서 이 세션에 한 번 접속(또는 연결 테스트)해 호스트 키를 확인한 뒤 다시 요청하세요.'
    }
  }
  return {
    error: `${where} 서버의 호스트 키를 신뢰하지 않아 접속하지 않았습니다.`,
    hint: '지문이 서버 관리자가 알려 준 값과 같은지 확인한 뒤 다시 접속하세요.'
  }
}

module.exports = { withHostKeyCheck, HostKeyError, isHostKeyError, hostKeyMessage }
