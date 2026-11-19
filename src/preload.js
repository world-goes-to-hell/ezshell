const { contextBridge, ipcRenderer, webFrame } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  startupReady: () => ipcRenderer.send('app-startup-ready'),
  // 창 컨트롤
  minimizeWindow: () => ipcRenderer.send('window-minimize'),
  maximizeWindow: () => ipcRenderer.send('window-maximize'),
  // See-through window (설정 > 테마 > 창 투명도); main clamps the value
  setWindowOpacity: (opacity) => ipcRenderer.send('window-set-opacity', opacity),
  // Glass surface style: the choice kept for the next start, and whether this window has acrylic now
  setAppearance: (value) => ipcRenderer.send('appearance-set', value),
  getBackdrop: () => ipcRenderer.invoke('appearance-backdrop'),
  // Popped-out SFTP window: it reports the folders it shows, and the main window hears when it closes
  sftpWindowPaths: (sessionId, localPath, remotePath) => ipcRenderer.send('sftp-window-paths', { sessionId, localPath, remotePath }),
  onSftpWindowClosed: (callback) => {
    const listener = (_event, info) => callback(info);
    ipcRenderer.on('sftp-window-closed', listener);
    return () => ipcRenderer.removeListener('sftp-window-closed', listener);
  },
  // A double press somewhere in a glass window (main cannot tell drag regions; the page can)
  onCaptionDoubleClick: (callback) => {
    const listener = (_event, point) => callback(point);
    ipcRenderer.on('window-caption-double-click', listener);
    return () => ipcRenderer.removeListener('window-caption-double-click', listener);
  },
  closeWindow: () => ipcRenderer.send('window-close'),
  toggleFullscreen: () => ipcRenderer.invoke('window-toggle-fullscreen'),

  // 앱 줌 (Ctrl+마우스 휠)
  appZoomIn: () => webFrame.setZoomLevel(webFrame.getZoomLevel() + 0.5),
  appZoomOut: () => webFrame.setZoomLevel(webFrame.getZoomLevel() - 0.5),
  appZoomReset: () => webFrame.setZoomLevel(0),
  getAppZoomFactor: () => webFrame.getZoomFactor(),
  setAppZoomFactor: (factor) => {
    // Chromium accepts 0.25-5; anything else is a renderer bug, not a zoom request
    if (typeof factor !== 'number' || !Number.isFinite(factor) || factor < 0.25 || factor > 5) return
    webFrame.setZoomFactor(factor)
  },

  // SSH 연결
  sshConnect: (config) => ipcRenderer.invoke('ssh-connect', config),
  sshTestConnection: (config) => ipcRenderer.invoke('ssh-test-connection', config),
  sshSend: (sessionId, data) => ipcRenderer.send('ssh-send', { sessionId, data }),
  sshDisconnect: (sessionId) => ipcRenderer.send('ssh-disconnect', { sessionId }),
  sshResize: (sessionId, cols, rows) => ipcRenderer.send('ssh-resize', { sessionId, cols, rows }),

  // Private Key 파일 선택
  selectPrivateKey: () => ipcRenderer.invoke('select-private-key'),

  // SSH 이벤트 수신 (전역 리스너 - 한 번만 등록됨)
  onSshData: (callback) => {
    // 기존 리스너 제거 후 새 리스너 등록
    ipcRenderer.removeAllListeners('ssh-data');
    ipcRenderer.on('ssh-data', (event, data) => callback(data));
    // 리스너 해제 함수 반환
    return () => ipcRenderer.removeAllListeners('ssh-data');
  },
  onSshClosed: (callback) => {
    ipcRenderer.removeAllListeners('ssh-closed');
    ipcRenderer.on('ssh-closed', (event, data) => callback(data));
    return () => ipcRenderer.removeAllListeners('ssh-closed');
  },
  onSshStateChanged: (callback) => ipcRenderer.on('ssh-state-changed', (event, data) => callback(data)),
  // Each returns its remover, so a popped-out terminal window can stop listening when it closes
  onSshReconnecting: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('ssh-reconnecting', handler);
    return () => ipcRenderer.removeListener('ssh-reconnecting', handler);
  },
  onSshReconnected: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('ssh-reconnected', handler);
    return () => ipcRenderer.removeListener('ssh-reconnected', handler);
  },
  onSshReconnectFailed: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('ssh-reconnect-failed', handler);
    return () => ipcRenderer.removeListener('ssh-reconnect-failed', handler);
  },
  sshCancelReconnect: (sessionId) => ipcRenderer.invoke('ssh-cancel-reconnect', { sessionId }),
  sshReconnectNow: (sessionId) => ipcRenderer.invoke('ssh-reconnect-now', { sessionId }),

  // ==================== SFTP API ====================

  // SFTP 세션
  sftpOpen: (sessionId) => ipcRenderer.invoke('sftp-open', { sessionId }),
  sftpClose: (sessionId) => ipcRenderer.invoke('sftp-close', { sessionId }),

  // 파일 작업
  sftpList: (sessionId, remotePath) => ipcRenderer.invoke('sftp-list', { sessionId, remotePath }),
  sftpDownload: (sessionId, remotePath, localPath) => ipcRenderer.invoke('sftp-download', { sessionId, remotePath, localPath }),
  sftpUpload: (sessionId, localPath, remotePath) => ipcRenderer.invoke('sftp-upload', { sessionId, localPath, remotePath }),
  sftpDelete: (sessionId, remotePath, isDirectory) => ipcRenderer.invoke('sftp-delete', { sessionId, remotePath, isDirectory }),
  onSftpListProgress: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('sftp-list-progress', handler);
    return () => ipcRenderer.removeListener('sftp-list-progress', handler);
  },
  sftpStat: (sessionId, remotePath) => ipcRenderer.invoke('sftp-stat', { sessionId, remotePath }),
  sftpRealpath: (sessionId, remotePath) => ipcRenderer.invoke('sftp-realpath', { sessionId, remotePath }),
  sftpRename: (sessionId, oldPath, newPath) => ipcRenderer.invoke('sftp-rename', { sessionId, oldPath, newPath }),
  sftpMkdir: (sessionId, remotePath) => ipcRenderer.invoke('sftp-mkdir', { sessionId, remotePath }),

  // 다이얼로그
  selectDownloadPath: (defaultName) => ipcRenderer.invoke('select-download-path', { defaultName }),
  selectUploadFiles: () => ipcRenderer.invoke('select-upload-files'),

  // SFTP 이벤트
  onSftpProgress: (callback) => {
    ipcRenderer.on('sftp-progress', (event, data) => callback(data));
  },

  // Transfer Queue API
  sftpQueueDownload: (sessionId, remotePath, localPath) =>
    ipcRenderer.invoke('sftp-queue-download', { sessionId, remotePath, localPath }),
  sftpQueueUpload: (sessionId, localPath, remotePath) =>
    ipcRenderer.invoke('sftp-queue-upload', { sessionId, localPath, remotePath }),
  sftpUploadDirectory: (sessionId, localDir, remoteDir) =>
    ipcRenderer.invoke('sftp-upload-directory', { sessionId, localDir, remoteDir }),
  sftpDownloadDirectory: (sessionId, remoteDir, localDir) =>
    ipcRenderer.invoke('sftp-download-directory', { sessionId, remoteDir, localDir }),
  sftpTransferPause: (sessionId, transferId) =>
    ipcRenderer.invoke('sftp-transfer-pause', { sessionId, transferId }),
  sftpTransferResume: (sessionId, transferId) =>
    ipcRenderer.invoke('sftp-transfer-resume', { sessionId, transferId }),
  sftpTransferRetry: (sessionId, transferId, overwrite = false) =>
    ipcRenderer.invoke('sftp-transfer-retry', { sessionId, transferId, overwrite }),
  sftpTransferCancel: (sessionId, transferId, failedOnly = false) =>
    ipcRenderer.invoke('sftp-transfer-cancel', { sessionId, transferId, failedOnly }),
  sftpQueueClearCompleted: (sessionId) =>
    ipcRenderer.invoke('sftp-queue-clear-completed', { sessionId }),
  sftpGetQueue: (sessionId) =>
    ipcRenderer.invoke('sftp-get-queue', { sessionId }),
  // Return an unsubscribe function so SFTP views can clean up when they close
  onSftpQueueUpdate: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('sftp-queue-update', handler);
    return () => ipcRenderer.removeListener('sftp-queue-update', handler);
  },
  onSftpTransferProgress: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('sftp-transfer-progress', handler);
    return () => ipcRenderer.removeListener('sftp-transfer-progress', handler);
  },

  // ==================== 로컬 파일 시스템 API ====================

  // 로컬 디렉토리 목록 조회
  localList: (dirPath) => ipcRenderer.invoke('local-list', { dirPath }),
  // Local terminal tabs (shells of this PC)
  localShellOpen: (options) => ipcRenderer.invoke('local-shell-open', options),
  localProjectInspect: (folder) => ipcRenderer.invoke('local-project-inspect', folder),
  workspaceDirectoryList: (folder, relative = '') => ipcRenderer.invoke('workspace-directory-list', { root: folder, path: relative }),
  workspaceGitStatus: (root) => ipcRenderer.invoke('workspace-git-status', root),
  workspaceGitCommitFiles: (root, hash) => ipcRenderer.invoke('workspace-git-commit-files', { root, hash }),
  workspaceGitDiff: (root, file, hash) => ipcRenderer.invoke('workspace-git-diff', { root, file, hash }),
  localFileOpen: (root, relative, mode, label, options) => ipcRenderer.invoke('local-file-open', { root, path: relative, mode, label, compareHead: options?.compareHead === true }),
  onRemoteFileCompareHead: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('remote-file-compare-head', handler);
    return () => ipcRenderer.removeListener('remote-file-compare-head', handler);
  },
  workspaceGitLog: (folder) => ipcRenderer.invoke('workspace-git-log', folder),
  localWorktreeCreate: (options) => ipcRenderer.invoke('local-worktree-create', options),
  // Past Claude Code and Codex sessions (right panel); only keys from the list go back
  agentHistoryList: (shellId) => ipcRenderer.invoke('agent-history-list', shellId),
  agentHistoryDetail: (shellId, key) => ipcRenderer.invoke('agent-history-detail', shellId, key),
  agentHistorySearch: (shellId, query) => ipcRenderer.invoke('agent-history-search', shellId, query),
  agentHistoryOpenFolder: (shellId, key) => ipcRenderer.invoke('agent-history-open-folder', shellId, key),
  localShellAttach: (id) => ipcRenderer.invoke('local-shell-attach', id),
  localShellList: () => ipcRenderer.invoke('local-shell-list'),
  localShellCurrentDirectory: (id) => ipcRenderer.invoke('local-shell-current-directory', id),
  localShellClipboard: (id) => ipcRenderer.invoke('local-shell-clipboard', id),
  localShellHasWorkingAgent: (ids) => ipcRenderer.invoke('local-shell-working-agent', ids),
  agentMessagesSnapshot: () => ipcRenderer.invoke('agent-messages-state'),
  browserReviewOpen: () => ipcRenderer.invoke('browser-review-open'),
  browserReviewState: (id) => ipcRenderer.invoke('browser-review-state', id),
  browserReviewAction: (id, request) => ipcRenderer.invoke('browser-review-action', id, request),
  browserReviewBounds: (id, bounds) => ipcRenderer.send('browser-review-bounds', id, bounds),
  browserReviewClose: (id) => ipcRenderer.send('browser-review-close', id),
  onBrowserReviewState: (callback) => {
    const listener = (_event, id, state) => callback(id, state);
    ipcRenderer.on('browser-review-state', listener);
    return () => ipcRenderer.removeListener('browser-review-state', listener);
  },
  onBrowserReviewFocus: (callback) => {
    const listener = (_event, id) => callback(id);
    ipcRenderer.on('browser-review-focus', listener);
    return () => ipcRenderer.removeListener('browser-review-focus', listener);
  },
  agentMessageMcpSetup: (kind) => ipcRenderer.invoke('agent-message-mcp-setup', kind),
  onAgentMessagesState: (callback) => {
    const handler = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on('agent-messages-state', handler);
    return () => ipcRenderer.removeListener('agent-messages-state', handler);
  },
  // Usage of launched agents for the status bar (numbers and the model name only)
  agentUsageState: () => ipcRenderer.invoke('agent-usage-state'),
  onAgentUsage: (callback) => {
    const handler = (_event, report) => callback(report);
    ipcRenderer.on('agent-usage', handler);
    return () => ipcRenderer.removeListener('agent-usage', handler);
  },
  onAgentMessageDelivered: (callback) => {
    const handler = (_event, delivery) => callback(delivery);
    ipcRenderer.on('agent-message-delivered', handler);
    return () => ipcRenderer.removeListener('agent-message-delivered', handler);
  },
  localShellWrite: (id, data) => ipcRenderer.send('local-shell-write', { id, data }),
  localShellComposing: (id, value) => ipcRenderer.send('local-shell-composing', { id, value }),
  localShellResize: (id, cols, rows) => ipcRenderer.send('local-shell-resize', { id, cols, rows }),
  localShellClose: (id) => ipcRenderer.send('local-shell-close', id),
  onLocalShellData: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('local-shell-data', handler);
    return () => ipcRenderer.removeListener('local-shell-data', handler);
  },
  onLocalShellExit: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('local-shell-exit', handler);
    return () => ipcRenderer.removeListener('local-shell-exit', handler);
  },
  // A local shell's agent as a chat (src/agentChat): the window names the shell, main picks the file
  agentChatOpen: (shellId) => ipcRenderer.invoke('agent-chat-open', shellId),
  agentChatOlder: (shellId) => ipcRenderer.invoke('agent-chat-older', shellId),
  agentChatClose: (shellId) => ipcRenderer.send('agent-chat-close', shellId),
  agentChatReadClipboard: (shellId) => ipcRenderer.invoke('agent-chat-read-clipboard', shellId),
  agentChatRemoveImage: (shellId, imageId) => ipcRenderer.send('agent-chat-remove-image', { shellId, imageId }),
  agentChatSend: (shellId, text, imageId) => ipcRenderer.invoke('agent-chat-send', { shellId, text, imageId }),
  agentChatInterrupt: (shellId) => ipcRenderer.invoke('agent-chat-interrupt', shellId),
  agentChatAnswer: (shellId, key, signature) => ipcRenderer.invoke('agent-chat-answer', { shellId, key, signature }),
  agentChatOpenLink: (shellId, href, how) => ipcRenderer.invoke('agent-chat-open-link', { shellId, href, how }),
  onAgentChatFrame: (callback) => {
    const handler = (event, frame) => callback(frame);
    ipcRenderer.on('agent-chat-frame', handler);
    return () => ipcRenderer.removeListener('agent-chat-frame', handler);
  },
  dbDdl: (dbId, database, schema, table) => ipcRenderer.invoke('db-ddl', { dbId, database, schema, table }),
  dbRelations: (dbId, sources) => ipcRenderer.invoke('db-relations', { dbId, sources }),
  // Oracle's client libraries, for Oracle servers older than 12.1 (the DB account dialog)
  oracleClientStatus: () => ipcRenderer.invoke('oracle-client-status'),
  oracleClientInstall: () => ipcRenderer.invoke('oracle-client-install'),
  oracleClientRemove: () => ipcRenderer.invoke('oracle-client-remove'),
  oracleClientLicense: () => ipcRenderer.invoke('oracle-client-license'),
  onOracleClientProgress: (callback) => {
    const handler = (event, progress) => callback(progress);
    ipcRenderer.on('oracle-client-progress', handler);
    return () => ipcRenderer.removeListener('oracle-client-progress', handler);
  },
  // Remote access (settings page of the main window)
  remoteAccessStatus: () => ipcRenderer.invoke('remote-access-status'),
  remoteAccessSetEnabled: (isEnabled) => ipcRenderer.invoke('remote-access-set-enabled', isEnabled),
  remoteAccessSetAnswerMcp: (isOn) => ipcRenderer.invoke('remote-access-set-answer-mcp', isOn),
  remoteAccessPairing: () => ipcRenderer.invoke('remote-access-pairing'),
  remoteAccessAuthenticator: () => ipcRenderer.invoke('remote-access-authenticator'),
  remoteAccessRevoke: (deviceId) => ipcRenderer.invoke('remote-access-revoke', deviceId),
  onRemoteAccessChanged: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('remote-access-changed', handler);
    return () => ipcRenderer.removeListener('remote-access-changed', handler);
  },
  // The path on this PC of a file dropped onto the window. Electron 32 removed `File.path`; from 29
  // on `webUtils.getPathForFile` gives it. Empty when it cannot be told (callers must not treat an
  // empty path as a file).
  getPathForFile: (file) => {
    try {
      const { webUtils } = require('electron');
      if (webUtils && typeof webUtils.getPathForFile === 'function') return webUtils.getPathForFile(file) || '';
    } catch {
      // Falls through to the old property
    }
    return file && typeof file.path === 'string' ? file.path : '';
  },
  saveExportFile: (defaultName, extension, data, kind) => ipcRenderer.invoke('save-export-file', { defaultName, extension, data, kind }),
  saveTerminalOutput: (defaultName, text) => ipcRenderer.invoke('save-terminal-output', { defaultName, text }),
  localRename: (oldPath, newPath) => ipcRenderer.invoke('local-rename', { oldPath, newPath }),
  localMkdir: (dirPath) => ipcRenderer.invoke('local-mkdir', { dirPath }),
  localMove: (sourcePath, targetDir) => ipcRenderer.invoke('local-move', { sourcePath, targetDir }),
  localTrash: (paths) => ipcRenderer.invoke('local-trash', { paths }),

  // 로컬 폴더 선택 다이얼로그
  selectLocalFolder: () => ipcRenderer.invoke('select-local-folder'),

  // ==================== 세션 영구 저장 API ====================

  loadSessions: () => ipcRenderer.invoke('load-sessions'),
  saveSessions: (sessions) => ipcRenderer.invoke('save-sessions', sessions),
  loadFolders: () => ipcRenderer.invoke('load-folders'),
  saveFolders: (data) => ipcRenderer.invoke('save-folders', data),

  // Session Import/Export
  exportSessions: (data) => ipcRenderer.invoke('export-sessions', data),
  importSessions: (mode) => ipcRenderer.invoke('import-sessions', mode),

  // ==================== 앱 설정 API ====================

  // ==================== SFTP 경로 즐겨찾기 ====================

  sshGetSessionInfo: (sessionId) => ipcRenderer.invoke('ssh-get-session-info', { sessionId }),
  pathBookmarksGet: (key) => ipcRenderer.invoke('path-bookmarks-get', { key }),
  pathBookmarksSet: (key, side, paths) => ipcRenderer.invoke('path-bookmarks-set', { key, side, paths }),
  onPathBookmarksChanged: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('path-bookmarks-changed', handler);
    return () => ipcRenderer.removeListener('path-bookmarks-changed', handler);
  },

  // ==================== 터미널 명령어 기록 ====================

  commandHistoryGet: (key) => ipcRenderer.invoke('command-history-get', { key }),
  commandHistoryAdd: (key, command) => ipcRenderer.invoke('command-history-add', { key, command }),
  commandHistoryRemove: (key, command) => ipcRenderer.invoke('command-history-remove', { key, command }),
  commandHistoryClear: (key) => ipcRenderer.invoke('command-history-clear', { key }),
  onCommandHistoryChanged: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('command-history-changed', handler);
    return () => ipcRenderer.removeListener('command-history-changed', handler);
  },

  loadSettings: () => ipcRenderer.invoke('load-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),

  // ==================== SFTP 창 분리 ====================

  openSftpWindow: (sessionId, localPath, remotePath, title) =>
    ipcRenderer.invoke('open-sftp-window', { sessionId, localPath, remotePath, title }),

  // ==================== 서버 파일 편집 / 미리보기 창 ====================
  // mode: 'edit' | 'preview'. The window's own calls name its docId (from the window URL).
  openRemoteFile: (sessionId, sessionName, remotePath, mode) =>
    ipcRenderer.invoke('remote-file-open', { sessionId, sessionName, remotePath, mode }),
  remoteFileLoad: (docId) => ipcRenderer.invoke('remote-file-load', { docId }),
  remoteFileTail: (docId, generation, cursor) => ipcRenderer.invoke('remote-file-tail', { docId, generation, cursor }),
  remoteFileFindDefinitions: (docId, name) => ipcRenderer.invoke('remote-file-find-definitions', { docId, name }),
  remoteFileOpenDefinition: (docId, key) => ipcRenderer.invoke('remote-file-open-definition', { docId, key }),
  onRemoteFileRevealLine: (callback) => {
    const handler = (_event, line) => { if (Number.isSafeInteger(line) && line > 0) callback(line) };
    ipcRenderer.on('remote-file-reveal-line', handler);
    return () => ipcRenderer.removeListener('remote-file-reveal-line', handler);
  },
  remoteFileAttention: (docId) => ipcRenderer.send('remote-file-attention', { docId }),
  // DB client (src/dbClient): discovery and opening from the main window, the rest from a DB window
  dbDiscover: (sessionId) => ipcRenderer.invoke('db-discover', { sessionId }),
  dbOpen: (sessionId, sessionName, endpoint, credentials, target) => ipcRenderer.invoke('db-open', { sessionId, sessionName, endpoint, credentials, target }),
  dbClose: (dbId) => ipcRenderer.invoke('db-close', { dbId }),
  dbDetach: (dbId) => ipcRenderer.invoke('db-detach', { dbId }),
  dbTest: (sessionId, endpoint, credentials) => ipcRenderer.invoke('db-test', { sessionId, endpoint, credentials }),
  dbInfo: (dbId) => ipcRenderer.invoke('db-info', { dbId }),
  dbDatabases: (dbId) => ipcRenderer.invoke('db-databases', { dbId }),
  dbSwitchDatabase: (dbId, database) => ipcRenderer.invoke('db-switch-database', { dbId, database }),
  dbSetSchema: (dbId, schema) => ipcRenderer.invoke('db-set-schema', { dbId, schema }),
  dbQuery: (dbId, sql) => ipcRenderer.invoke('db-query', { dbId, sql }),
  dbCancel: (dbId) => ipcRenderer.invoke('db-cancel', { dbId }),
  dbSchemas: (dbId, database) => ipcRenderer.invoke('db-schemas', { dbId, database }),
  dbTables: (dbId, database, schema) => ipcRenderer.invoke('db-tables', { dbId, database, schema }),
  dbColumns: (dbId, database, schema, table) => ipcRenderer.invoke('db-columns', { dbId, database, schema, table }),
  remoteFileReview: (docId, content) => ipcRenderer.invoke('remote-file-review', { docId, content }),
  remoteFileSave: (docId, content, token) => ipcRenderer.invoke('remote-file-save', { docId, content, token }),
  remoteFileBackups: (docId) => ipcRenderer.invoke('remote-file-backups', { docId }),
  remoteFileReadBackup: (docId, name) => ipcRenderer.invoke('remote-file-read-backup', { docId, name }),
  remoteFileServerBackups: (docId) => ipcRenderer.invoke('remote-file-server-backups', { docId }),
  remoteFileReadServerBackup: (docId, name) => ipcRenderer.invoke('remote-file-read-server-backup', { docId, name }),
  remoteFileOpenBackupFolder: (docId) => ipcRenderer.invoke('remote-file-open-backup-folder', { docId }),
  remoteFileSetDirty: (docId, isDirty) => ipcRenderer.send('remote-file-dirty', { docId, isDirty }),
  remoteFileClose: (docId) => ipcRenderer.invoke('remote-file-close', { docId }),
  onRemoteFileCloseRequested: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('remote-file-close-requested', handler);
    return () => ipcRenderer.removeListener('remote-file-close-requested', handler);
  },

  // ==================== 터미널 창 분리 ====================

  // snapshot: serialized screen of the tab, shown first in the new window
  openTerminalWindow: (sessionId, title, snapshot) =>
    ipcRenderer.invoke('open-terminal-window', { sessionId, title, snapshot }),

  takeTerminalSnapshot: (sessionId) => ipcRenderer.invoke('take-terminal-snapshot', { sessionId }),

  mergeTerminalToMain: (sessionId, title, host, username, snapshot) =>
    ipcRenderer.invoke('merge-terminal-to-main', { sessionId, title, host, username, snapshot }),

  onTerminalMerge: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('terminal-merge', handler);
    return () => ipcRenderer.removeListener('terminal-merge', handler);
  },

  // ==================== 마스터 비밀번호 API ====================

  hasMasterPassword: () => ipcRenderer.invoke('has-master-password'),
  setupMasterPassword: (password) => ipcRenderer.invoke('setup-master-password', { password }),
  unlockApp: (password) => ipcRenderer.invoke('unlock-app', { password }),
  lockApp: (restoreRecord) => ipcRenderer.invoke('lock-app', restoreRecord),
  isAppLocked: () => ipcRenderer.invoke('is-app-locked'),
  resetMasterPassword: () => ipcRenderer.invoke('reset-master-password'),
  saveAutoUnlock: (password) => ipcRenderer.invoke('save-auto-unlock', { password }),
  loadAutoUnlock: () => ipcRenderer.invoke('load-auto-unlock'),
  clearAutoUnlock: () => ipcRenderer.invoke('clear-auto-unlock'),
  hasAutoUnlock: () => ipcRenderer.invoke('has-auto-unlock'),

  // ==================== 분할 터미널 API ====================

  sshCreateShell: (sessionId) => ipcRenderer.invoke('ssh-create-shell', { sessionId }),
  sshSplitSend: (streamId, data) => ipcRenderer.send('ssh-split-send', { streamId, data }),
  sshSplitResize: (streamId, cols, rows) => ipcRenderer.send('ssh-split-resize', { streamId, cols, rows }),
  sshSplitClose: (streamId) => ipcRenderer.send('ssh-split-close', { streamId }),
  sshAdoptSplit: (streamId) => ipcRenderer.invoke('ssh-adopt-split', { streamId }),
  sshPromotePane: (sessionId, streamId, closePrevious) => ipcRenderer.invoke('ssh-promote-pane', { sessionId, streamId, closePrevious }),
  sshResumePromotedPane: (sessionId, streamId) => ipcRenderer.send('ssh-resume-promoted-pane', { sessionId, streamId }),
  sshMergeTab: (sourceId, targetId) => ipcRenderer.invoke('ssh-merge-tab', { sourceId, targetId }),
  containerList: (sessionId, all) => ipcRenderer.invoke('container-list', { sessionId, all }),
  containerLogOpen: (sessionId, sessionName, name) => ipcRenderer.invoke('container-log-open', { sessionId, sessionName, name }),
  onSshSplitData: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('ssh-split-data', handler);
    return () => ipcRenderer.removeListener('ssh-split-data', handler);
  },
  onSshSplitClosed: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('ssh-split-closed', handler);
    return () => ipcRenderer.removeListener('ssh-split-closed', handler);
  },

  // ==================== 명령어 실행 API ====================

  sshExecCommand: (sessionId, command) => ipcRenderer.invoke('ssh-exec-command', { sessionId, command }),

  // ==================== 자동 업데이트 API ====================

  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  downloadUpdate: () => ipcRenderer.invoke('download-update'),
  restoreTabsSave: (record) => ipcRenderer.invoke('restore-tabs-save', record),
  restoreTabsTake: () => ipcRenderer.invoke('restore-tabs-take'),
  onRestoreTabsBeforeClose: (readRecord) => {
    const handler = (_, id) => {
      let record = null;
      try { record = readRecord(); } finally { ipcRenderer.send('restore-tabs-close-record', { id, record }); }
    };
    ipcRenderer.on('restore-tabs-before-close', handler);
    return () => ipcRenderer.removeListener('restore-tabs-before-close', handler);
  },
  updateBusyWork: () => ipcRenderer.invoke('update-busy-work'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  openUpdatePage: () => ipcRenderer.invoke('open-update-page'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  whatsNewState: () => ipcRenderer.invoke('whats-new-state'),
  localPlaces: () => ipcRenderer.invoke('local-places'),
  sessionImportSources: () => ipcRenderer.invoke('session-import-sources'),
  sessionImportRead: (id) => ipcRenderer.invoke('session-import-read', id),
  sessionImportFile: () => ipcRenderer.invoke('session-import-file'),
  whatsNewSeen: () => ipcRenderer.invoke('whats-new-seen'),
  onUpdateStatus: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('update-status', handler);
    return () => ipcRenderer.removeListener('update-status', handler);
  },

  // ==================== 포트 포워딩 API ====================

  portForwardLocal: (sessionId, localPort, remoteHost, remotePort, localHost) =>
    ipcRenderer.invoke('port-forward-local', { sessionId, localPort, remoteHost, remotePort, localHost }),
  portForwardRemote: (sessionId, remotePort, localHost, localPort, remoteHost) =>
    ipcRenderer.invoke('port-forward-remote', { sessionId, remotePort, localHost, localPort, remoteHost }),
  portForwardDynamic: (sessionId, localPort, localHost) =>
    ipcRenderer.invoke('port-forward-dynamic', { sessionId, localPort, localHost }),
  portForwardStop: (forwardId) =>
    ipcRenderer.invoke('port-forward-stop', { forwardId }),
  portForwardList: (sessionId) =>
    ipcRenderer.invoke('port-forward-list', { sessionId }),
  onPortForwardUpdate: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('port-forward-update', handler);
    return () => ipcRenderer.removeListener('port-forward-update', handler);
  },

  // Terminal zoom (from main process intercepting Ctrl+/-/0)
  onTerminalZoom: (callback) => {
    ipcRenderer.removeAllListeners('terminal-zoom');
    ipcRenderer.on('terminal-zoom', (event, direction) => callback(direction));
    return () => ipcRenderer.removeAllListeners('terminal-zoom');
  },

  // 세션 로그 (터미널 출력을 파일로 저장)
  sessionLogStart: (sessionId, name) => ipcRenderer.invoke('session-log-start', { sessionId, name }),
  sessionLogStop: (sessionId) => ipcRenderer.invoke('session-log-stop', { sessionId }),
  sessionLogList: () => ipcRenderer.invoke('session-log-list'),
  sessionLogOpenFolder: () => ipcRenderer.invoke('session-log-open-folder'),
  onSessionLogChanged: (callback) => {
    const handler = (event, payload) => callback(payload);
    ipcRenderer.on('session-log-changed', handler);
    return () => ipcRenderer.removeListener('session-log-changed', handler);
  },

  // MCP 서버 (Claude Code)
  mcpGetStatus: () => ipcRenderer.invoke('mcp-get-status'),
  mcpUpdateConfig: (patch) => ipcRenderer.invoke('mcp-update-config', patch),
  mcpRegenerateToken: () => ipcRenderer.invoke('mcp-regenerate-token'),
  mcpRespondApproval: (id, approved) => ipcRenderer.invoke('mcp-respond-approval', { id, approved }),
  mcpReadAudit: (limit) => ipcRenderer.invoke('mcp-read-audit', { limit }),
  mcpListActivity: () => ipcRenderer.invoke('mcp-list-activity'),
  openMcpActivityWindow: () => ipcRenderer.invoke('open-mcp-activity-window'),
  mcpCancelActivity: (id) => ipcRenderer.invoke('mcp-cancel-activity', { id }),
  mcpSetupClient: (request) => ipcRenderer.invoke('mcp-setup-client', request),
  mcpAddTransferFolder: () => ipcRenderer.invoke('mcp-add-transfer-folder'),
  mcpRemoveTransferFolder: (path) => ipcRenderer.invoke('mcp-remove-transfer-folder', { path }),
  onMcpActivity: (callback) => {
    const handler = (event, item) => callback(item);
    ipcRenderer.on('mcp-activity', handler);
    return () => ipcRenderer.removeListener('mcp-activity', handler);
  },
  onMcpActivityOutput: (callback) => {
    const handler = (event, payload) => callback(payload);
    ipcRenderer.on('mcp-activity-output', handler);
    return () => ipcRenderer.removeListener('mcp-activity-output', handler);
  },
  onMcpApprovalRequest: (callback) => {
    const handler = (event, request) => callback(request);
    ipcRenderer.on('mcp-approval-request', handler);
    return () => ipcRenderer.removeListener('mcp-approval-request', handler);
  },
  onMcpApprovalDismiss: (callback) => {
    const handler = (event, payload) => callback(payload);
    ipcRenderer.on('mcp-approval-dismiss', handler);
    return () => ipcRenderer.removeListener('mcp-approval-dismiss', handler);
  },

  // SSH host key check: main asks, the window answers with the request id and 'trust' | 'reject'
  onHostKeyPrompt: (callback) => {
    const handler = (event, request) => callback(request);
    ipcRenderer.on('host-key-prompt', handler);
    return () => ipcRenderer.removeListener('host-key-prompt', handler);
  },
  onHostKeyDismiss: (callback) => {
    const handler = (event, payload) => callback(payload);
    ipcRenderer.on('host-key-dismiss', handler);
    return () => ipcRenderer.removeListener('host-key-dismiss', handler);
  },
  respondHostKey: (id, decision) => ipcRenderer.send('host-key-respond', { id, decision })
});
