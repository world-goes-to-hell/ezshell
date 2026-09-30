const { contextBridge, ipcRenderer, webFrame } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // 창 컨트롤
  minimizeWindow: () => ipcRenderer.send('window-minimize'),
  maximizeWindow: () => ipcRenderer.send('window-maximize'),
  closeWindow: () => ipcRenderer.send('window-close'),
  toggleFullscreen: () => ipcRenderer.invoke('window-toggle-fullscreen'),

  // 앱 줌 (Ctrl+마우스 휠)
  appZoomIn: () => webFrame.setZoomLevel(webFrame.getZoomLevel() + 0.5),
  appZoomOut: () => webFrame.setZoomLevel(webFrame.getZoomLevel() - 0.5),
  appZoomReset: () => webFrame.setZoomLevel(0),

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
  onSshReconnecting: (callback) => ipcRenderer.on('ssh-reconnecting', (event, data) => callback(data)),
  onSshReconnected: (callback) => ipcRenderer.on('ssh-reconnected', (event, data) => callback(data)),
  onSshReconnectFailed: (callback) => ipcRenderer.on('ssh-reconnect-failed', (event, data) => callback(data)),
  sshCancelReconnect: (sessionId) => ipcRenderer.invoke('ssh-cancel-reconnect', { sessionId }),

  // ==================== SFTP API ====================

  // SFTP 세션
  sftpOpen: (sessionId) => ipcRenderer.invoke('sftp-open', { sessionId }),
  sftpClose: (sessionId) => ipcRenderer.invoke('sftp-close', { sessionId }),

  // 파일 작업
  sftpList: (sessionId, remotePath) => ipcRenderer.invoke('sftp-list', { sessionId, remotePath }),
  sftpDownload: (sessionId, remotePath, localPath) => ipcRenderer.invoke('sftp-download', { sessionId, remotePath, localPath }),
  sftpUpload: (sessionId, localPath, remotePath) => ipcRenderer.invoke('sftp-upload', { sessionId, localPath, remotePath }),
  sftpDelete: (sessionId, remotePath, isDirectory) => ipcRenderer.invoke('sftp-delete', { sessionId, remotePath, isDirectory }),
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
  sftpTransferPause: (sessionId, transferId) =>
    ipcRenderer.invoke('sftp-transfer-pause', { sessionId, transferId }),
  sftpTransferResume: (sessionId, transferId) =>
    ipcRenderer.invoke('sftp-transfer-resume', { sessionId, transferId }),
  sftpTransferCancel: (sessionId, transferId) =>
    ipcRenderer.invoke('sftp-transfer-cancel', { sessionId, transferId }),
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
  localRename: (oldPath, newPath) => ipcRenderer.invoke('local-rename', { oldPath, newPath }),
  localMkdir: (dirPath) => ipcRenderer.invoke('local-mkdir', { dirPath }),
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

  openSftpWindow: (sessionId, localPath, remotePath) =>
    ipcRenderer.invoke('open-sftp-window', { sessionId, localPath, remotePath }),

  // ==================== 터미널 창 분리 ====================

  openTerminalWindow: (sessionId, title) =>
    ipcRenderer.invoke('open-terminal-window', { sessionId, title }),

  mergeTerminalToMain: (sessionId, title, host, username) =>
    ipcRenderer.invoke('merge-terminal-to-main', { sessionId, title, host, username }),

  onTerminalMerge: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('terminal-merge', handler);
    return () => ipcRenderer.removeListener('terminal-merge', handler);
  },

  // ==================== 마스터 비밀번호 API ====================

  hasMasterPassword: () => ipcRenderer.invoke('has-master-password'),
  setupMasterPassword: (password) => ipcRenderer.invoke('setup-master-password', { password }),
  unlockApp: (password) => ipcRenderer.invoke('unlock-app', { password }),
  lockApp: () => ipcRenderer.invoke('lock-app'),
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
  installUpdate: () => ipcRenderer.invoke('install-update'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
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
  }
});
