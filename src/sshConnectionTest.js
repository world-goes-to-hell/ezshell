// Connection test for the session modal: authenticate once, report the result, disconnect.
// No shell is opened, so nothing runs on the server.
const fs = require('fs');
const { Client } = require('ssh2');

const DEFAULT_READY_TIMEOUT_MS = 20000;
const DEFAULT_SSH_PORT = 22;
// Extra time on top of ssh2's readyTimeout before the test gives up on its own
const DEFAULT_GRACE_MS = 5000;

const ERROR_RULES = [
  { test: (e) => e.level === 'client-authentication' || /authentication methods failed/i.test(e.message),
    error: '인증에 실패했습니다.', hint: '사용자명, 비밀번호 또는 Private Key를 확인하세요.' },
  { test: (e) => /no passphrase given|bad passphrase|Encrypted private key/i.test(e.message),
    error: 'Private Key를 열 수 없습니다. Passphrase를 확인하세요.' },
  { test: (e) => /Cannot parse privateKey|Unsupported key format/i.test(e.message),
    error: 'Private Key 형식을 읽을 수 없습니다.', hint: 'OpenSSH 또는 PEM 형식의 키인지 확인하세요.' },
  { test: (e) => e.code === 'ECONNREFUSED',
    error: '서버가 연결을 거부했습니다.', hint: '포트 번호와 SSH 서비스 실행 여부를 확인하세요.' },
  { test: (e) => e.code === 'ENOTFOUND' || e.code === 'EAI_AGAIN',
    error: '호스트를 찾을 수 없습니다.', hint: '호스트 주소(도메인)를 확인하세요.' },
  { test: (e) => e.code === 'EHOSTUNREACH' || e.code === 'ENETUNREACH',
    error: '호스트에 도달할 수 없습니다.', hint: '네트워크 또는 VPN 연결을 확인하세요.' },
  { test: (e) => e.code === 'ECONNRESET',
    error: '서버가 연결을 끊었습니다.', hint: '방화벽이나 접속 허용 IP 설정을 확인하세요.' },
  { test: (e) => e.level === 'client-timeout' || e.code === 'ETIMEDOUT' || /timed out/i.test(e.message),
    error: '응답 대기 시간이 초과되었습니다.', hint: '호스트, 포트, 방화벽 설정을 확인하세요.' }
];

/** Map an ssh2 / socket error to a Korean message, keeping the raw text as detail. */
function describeSshError(err) {
  const rule = ERROR_RULES.find(r => r.test(err));
  const detail = err.message || String(err);
  if (!rule) return { error: '연결에 실패했습니다.', detail };
  return { error: rule.error, hint: rule.hint, detail };
}

class ConnectionTestError extends Error {
  constructor(error, detail) {
    super(error);
    this.userMessage = error;
    this.detail = detail;
  }
}

function buildAuthOptions({ authType, password, privateKeyPath, passphrase }, readFile, label) {
  if (authType !== 'privateKey') return { password };
  if (!privateKeyPath) throw new ConnectionTestError(`${label}Private Key 파일이 선택되지 않았습니다.`);
  let privateKey;
  try {
    privateKey = readFile(privateKeyPath);
  } catch (err) {
    throw new ConnectionTestError(`${label}Private Key 파일을 읽을 수 없습니다.`, err.message);
  }
  return passphrase ? { privateKey, passphrase } : { privateKey };
}

function buildOptions(config, readFile) {
  const readyTimeout = config.connectTimeout || DEFAULT_READY_TIMEOUT_MS;
  const target = {
    host: config.host.trim(),
    port: config.port || DEFAULT_SSH_PORT,
    username: config.username.trim(),
    readyTimeout,
    ...buildAuthOptions(config, readFile, '')
  };
  if (!config.useJumpHost) return { target, jump: null, readyTimeout };

  if (!config.jumpHost || !config.jumpHost.trim()) {
    throw new ConnectionTestError('Jump 호스트가 입력되지 않았습니다.');
  }
  const jump = {
    host: config.jumpHost.trim(),
    port: config.jumpPort || DEFAULT_SSH_PORT,
    username: (config.jumpUsername || config.username).trim(),
    readyTimeout,
    ...buildAuthOptions({
      authType: config.jumpAuthType,
      password: config.jumpPassword,
      privateKeyPath: config.jumpPrivateKeyPath,
      passphrase: config.jumpPassphrase
    }, readFile, 'Jump Host ')
  };
  return { target, jump, readyTimeout };
}

const failure = (stage, err) => ({ success: false, stage, ...describeSshError(err) });

/**
 * Try to authenticate against the target (optionally through a jump host) and disconnect.
 * Resolves with { success, elapsedMs, viaJumpHost } or { success: false, stage, error, hint?, detail? }.
 * `deps` exists for tests; production uses ssh2's Client and fs.readFileSync.
 */
function testSshConnection(config, deps = {}) {
  const createClient = deps.createClient || (() => new Client());
  const readFile = deps.readFile || fs.readFileSync;
  const graceMs = deps.graceMs ?? DEFAULT_GRACE_MS;

  if (!config || !config.host || !config.host.trim() || !config.username || !config.username.trim()) {
    return Promise.resolve({ success: false, stage: 'target', error: '호스트와 사용자명을 입력하세요.' });
  }

  let options;
  try {
    options = buildOptions(config, readFile);
  } catch (err) {
    const stage = err.userMessage && err.userMessage.startsWith('Jump') ? 'jump' : 'target';
    return Promise.resolve({ success: false, stage, error: err.userMessage || err.message, detail: err.detail });
  }

  const startedAt = Date.now();
  const clients = [];

  return new Promise((resolve) => {
    let settled = false;
    let timer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const client of clients) {
        try { client.end(); } catch (e) { /* already closed */ }
      }
      resolve(result);
    };

    const stageCount = options.jump ? 2 : 1;
    timer = setTimeout(() => {
      finish(failure(clients.length > 1 || !options.jump ? 'target' : 'jump',
        Object.assign(new Error('Connection test timed out'), { level: 'client-timeout' })));
    }, options.readyTimeout * stageCount + graceMs);

    const connectTarget = (sock) => {
      const client = createClient();
      clients.push(client);
      client.on('ready', () => finish({ success: true, elapsedMs: Date.now() - startedAt, viaJumpHost: Boolean(sock) }));
      client.on('error', (err) => finish(failure('target', err)));
      client.connect(sock ? { ...options.target, sock } : options.target);
    };

    if (!options.jump) {
      connectTarget(null);
      return;
    }

    const jumpClient = createClient();
    clients.push(jumpClient);
    jumpClient.on('ready', () => {
      jumpClient.forwardOut('127.0.0.1', 0, options.target.host, options.target.port, (err, stream) => {
        if (err) {
          finish({ success: false, stage: 'jump', error: 'Jump Host에서 대상 서버로 터널을 열지 못했습니다.', detail: err.message });
          return;
        }
        connectTarget(stream);
      });
    });
    jumpClient.on('error', (err) => finish(failure('jump', err)));
    jumpClient.connect(options.jump);
  });
}

module.exports = { describeSshError, testSshConnection, buildOptions };
