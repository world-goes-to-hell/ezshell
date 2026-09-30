export interface SessionConfig {
  id: string
  name: string
  host: string
  port: number
  username: string
  authType: 'password' | 'privateKey'
  password?: string
  privateKeyPath?: string
  passphrase?: string
  folderId?: string
}

export interface FolderConfig {
  id: string
  name: string
}

export interface TerminalSession {
  id: string
  config: SessionConfig
  connected: boolean
}

export type PathBookmarkSide = 'local' | 'remote'

export interface PathBookmarkEntry {
  local: string[]
  remote: string[]
}

export interface CommandHistoryEntry {
  command: string
  lastUsedAt: number
}

export interface CommandHistoryResult {
  success: boolean
  entries?: CommandHistoryEntry[]
  error?: string
}

export interface SshSessionInfo {
  host: string
  port: number
  username: string
  savedSessionId: string | null
}

export type SshConnectionTestResult =
  | { success: true; elapsedMs: number; viaJumpHost: boolean }
  | { success: false; stage: 'jump' | 'target'; error: string; hint?: string; detail?: string }

export type LocalFileOpResult = { success: true } | { success: false; error: string }

export interface LocalTrashResult {
  trashed: number
  failures: { path: string; error: string }[]
}

// Extend Window interface for electronAPI
declare global {
  interface Window {
    electronAPI: {
      // Window controls
      minimizeWindow: () => void
      maximizeWindow: () => void
      closeWindow: () => void
      toggleFullscreen: () => Promise<void>

      // SSH
      sshConnect: (config: any) => Promise<any>
      sshTestConnection: (config: any) => Promise<SshConnectionTestResult>
      sshSend: (sessionId: string, data: string) => void
      sshDisconnect: (sessionId: string) => void
      sshResize: (sessionId: string, cols: number, rows: number) => void
      onSshData: (callback: (data: any) => void) => () => void
      onSshClosed: (callback: (data: any) => void) => () => void

      // SSH reconnection
      onSshStateChanged: (callback: (data: any) => void) => void
      onSshReconnecting: (callback: (data: { sessionId: string; attempt: number; maxAttempts: number }) => void) => void
      onSshReconnected: (callback: (data: { sessionId: string }) => void) => void
      onSshReconnectFailed: (callback: (data: { sessionId: string; message?: string }) => void) => void
      sshCancelReconnect: (sessionId: string) => Promise<any>

      // Split terminal (independent shell channels)
      sshCreateShell: (sessionId: string) => Promise<{ success: boolean; streamId?: string; error?: string }>
      sshSplitSend: (streamId: string, data: string) => void
      sshSplitResize: (streamId: string, cols: number, rows: number) => void
      sshSplitClose: (streamId: string) => void
      onSshSplitData: (callback: (data: any) => void) => () => void
      onSshSplitClosed: (callback: (data: any) => void) => () => void

      // Command execution
      sshExecCommand: (sessionId: string, command: string) => Promise<any>

      // Private Key
      selectPrivateKey: () => Promise<{ success: boolean; path?: string }>

      // SFTP
      sftpOpen: (sessionId: string) => Promise<any>
      sftpClose: (sessionId: string) => Promise<any>
      sftpList: (sessionId: string, remotePath: string) => Promise<any>
      sftpDownload: (sessionId: string, remotePath: string, localPath: string) => Promise<any>
      sftpUpload: (sessionId: string, localPath: string, remotePath: string) => Promise<any>
      sftpDelete: (sessionId: string, remotePath: string, isDirectory: boolean) => Promise<any>
      sftpRename: (sessionId: string, oldPath: string, newPath: string) => Promise<any>
      sftpMkdir: (sessionId: string, remotePath: string) => Promise<any>
      selectDownloadPath: (defaultName: string) => Promise<any>
      selectUploadFiles: () => Promise<any>
      onSftpProgress: (callback: (data: any) => void) => void

      // Transfer Queue
      sftpQueueDownload: (sessionId: string, remotePath: string, localPath: string) => Promise<any>
      sftpQueueUpload: (sessionId: string, localPath: string, remotePath: string) => Promise<any>
      sftpUploadDirectory?: (sessionId: string, localDir: string, remoteDir: string) => Promise<{ success: boolean; uploadedFiles: string[] }>
      sftpTransferPause: (sessionId: string, transferId: string) => Promise<any>
      sftpTransferResume: (sessionId: string, transferId: string) => Promise<any>
      sftpTransferCancel: (sessionId: string, transferId: string) => Promise<any>
      sftpQueueClearCompleted: (sessionId: string) => Promise<any>
      sftpGetQueue: (sessionId: string) => Promise<any>
      // Unsubscribe function; absent on preloads built before it was added
      onSftpQueueUpdate: (callback: (data: any) => void) => (() => void) | void
      onSftpTransferProgress: (callback: (data: any) => void) => (() => void) | void

      // Local file system
      localList: (dirPath: string) => Promise<any>
      localRename: (oldPath: string, newPath: string) => Promise<LocalFileOpResult>
      localMkdir: (dirPath: string) => Promise<LocalFileOpResult>
      /** Move an entry into another folder (same name); absent until the app restarts after an update */
      localMove?: (sourcePath: string, targetDir: string) => Promise<LocalFileOpResult>
      localTrash: (paths: string[]) => Promise<LocalTrashResult>
      selectLocalFolder: () => Promise<string | null>

      // SFTP Window
      openSftpWindow?: (sessionId: string, localPath: string, remotePath: string) => Promise<any>

      // Terminal Window
      openTerminalWindow: (sessionId: string, title: string) => Promise<any>
      mergeTerminalToMain: (sessionId: string, title: string, host: string, username: string) => Promise<any>
      onTerminalMerge: (callback: (data: any) => void) => () => void

      // Sessions
      loadSessions: () => Promise<any>
      saveSessions: (sessions: any) => Promise<any>
      loadFolders: () => Promise<any>
      saveFolders: (folders: any) => Promise<any>
      exportSessions: (data: any) => Promise<any>
      importSessions: (mode: 'merge' | 'replace') => Promise<any>

      // SFTP path bookmarks (stored per saved session)
      sshGetSessionInfo: (sessionId: string) => Promise<SshSessionInfo | null>
      pathBookmarksGet: (key: string) => Promise<PathBookmarkEntry>
      pathBookmarksSet: (key: string, side: PathBookmarkSide, paths: string[]) => Promise<{ success: boolean; entry?: PathBookmarkEntry; error?: string }>
      onPathBookmarksChanged: (callback: (data: { key: string; entry: PathBookmarkEntry }) => void) => () => void

      // Terminal command history (per connection, encrypted in the main process)
      commandHistoryGet: (key: string) => Promise<CommandHistoryResult>
      commandHistoryAdd: (key: string, command: string) => Promise<CommandHistoryResult>
      commandHistoryRemove: (key: string, command: string) => Promise<CommandHistoryResult>
      commandHistoryClear: (key: string) => Promise<CommandHistoryResult>
      onCommandHistoryChanged: (callback: (data: { key: string; entries: CommandHistoryEntry[] }) => void) => () => void

      // App settings
      loadSettings: () => Promise<any>
      saveSettings: (settings: any) => Promise<any>

      // Master Password
      hasMasterPassword: () => Promise<boolean>
      setupMasterPassword: (password: string) => Promise<{ success: boolean; error?: string }>
      unlockApp: (password: string) => Promise<{ success: boolean; error?: string }>
      lockApp: () => Promise<{ success: boolean }>
      isAppLocked: () => Promise<{ locked: boolean }>
      resetMasterPassword: () => Promise<{ success: boolean }>

      // Auto-unlock (OS keychain via safeStorage)
      saveAutoUnlock: (password: string) => Promise<any>
      loadAutoUnlock: () => Promise<any>
      clearAutoUnlock: () => Promise<any>
      hasAutoUnlock: () => Promise<any>

      // Auto update
      checkForUpdates: () => Promise<import('../lib/updateCheck').UpdateCheckResult>
      downloadUpdate: () => Promise<any>
      installUpdate: () => Promise<any>
      getAppVersion: () => Promise<string>
      onUpdateStatus: (callback: (data: any) => void) => () => void

      // Port forwarding
      portForwardLocal: (sessionId: string, localPort: number, remoteHost: string, remotePort: number, localHost?: string) => Promise<any>
      portForwardRemote: (sessionId: string, remotePort: number, localHost: string, localPort: number, remoteHost?: string) => Promise<any>
      portForwardDynamic: (sessionId: string, localPort: number, localHost?: string) => Promise<any>
      portForwardStop: (forwardId: string) => Promise<any>
      portForwardList: (sessionId: string) => Promise<any>
      onPortForwardUpdate: (callback: (data: any) => void) => () => void

      // Terminal zoom
      onTerminalZoom?: (callback: (direction: string) => void) => (() => void)

      // App zoom (Ctrl+mouse wheel)
      appZoomIn?: () => void
      appZoomOut?: () => void
      appZoomReset?: () => void
      getAppZoomFactor?: () => number
      setAppZoomFactor?: (factor: number) => void
    }
  }
}
