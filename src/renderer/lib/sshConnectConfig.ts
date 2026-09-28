import type { Session } from '../stores/sessionStore'
import type { SSHConnectConfig } from '../hooks/useSSH'

const DEFAULT_CONNECT_TIMEOUT_SEC = 20
const DEFAULT_KEEPALIVE_INTERVAL_SEC = 30
const DEFAULT_SSH_PORT = 22

// Saved sessions and the connect modal both store timeouts in seconds
export type SessionConnectSource = Omit<Session, 'id' | 'name' | 'icon'> & { id?: string; name?: string }

/**
 * Build the full SSH connect config from a saved session or connect modal input.
 * Converts second-based timeouts to milliseconds for the main process.
 */
export function toSSHConnectConfig(session: SessionConnectSource, color?: string): SSHConnectConfig {
  return {
    host: session.host,
    port: session.port || DEFAULT_SSH_PORT,
    username: session.username,
    authType: session.authType,
    password: session.password,
    privateKeyPath: session.privateKeyPath,
    passphrase: session.passphrase,
    sessionName: session.name || `${session.username}@${session.host}`,
    color: color ?? session.backgroundColor,
    postConnectScript: session.postConnectScript,
    savedSessionId: session.id,
    connectTimeout: (session.connectTimeout || DEFAULT_CONNECT_TIMEOUT_SEC) * 1000,
    keepaliveInterval: (session.keepaliveInterval || DEFAULT_KEEPALIVE_INTERVAL_SEC) * 1000,
    autoReconnect: session.autoReconnect !== false,
    useJumpHost: session.useJumpHost,
    jumpHost: session.jumpHost,
    jumpPort: session.jumpPort,
    jumpUsername: session.jumpUsername,
    jumpAuthType: session.jumpAuthType,
    jumpPassword: session.jumpPassword,
    jumpPrivateKeyPath: session.jumpPrivateKeyPath,
    jumpPassphrase: session.jumpPassphrase
  }
}
