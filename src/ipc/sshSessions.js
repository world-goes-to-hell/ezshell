// A tab's SSH connection: connecting (jump host, host key check, root switch), the shell's data,
// what happens when the shell or the connection ends (automatic reconnect, or a note when the shell
// exited by itself), the reconnect button, disconnecting, and the session log's IPC.
// Moved out of main.js as it was; see CLAUDE.md (Connection Lost Overlay, SSH Host Key
// Verification, Split Panes) for the rules this code keeps.

const fs = require('fs');
const { Client } = require('ssh2');
const sharedConn = require('../sharedConn.js');
const { SSH_ALGORITHMS } = require('../sshAlgorithms.js');
const { switchToRoot } = require('../rootSwitch.js');
const { readPrivateKeyFile } = require('../localKeyPath.js');
const { testSshConnection, describeSshError, normalizeConnectConfig } = require('../sshConnectionTest.js');
const { withHostKeyCheck, isHostKeyError, hostKeyMessage } = require('../hostKeys/hostKeyCheck.js');

function registerSshSessionIpc(ctx) {
  const { ipcMain, shell, sshConnections, sshStreams, splitStreamHandlers, connectionStates, ConnectionState, updateConnectionState, getWindowForSession, hostKeyStore, hostKeyPrompter, checkHostKeyAsking, hostKeyFailureText, setupRemoteForwardHandler, cleanupPortForwards, containers, getSessionLogger, notifySessionLog, endSessionLog, sessionLogDir, MAX_SESSION_LOG_NAME, closeSftpSession } = ctx;

  // Why a tab's shell ended, written to the console. The shell exited by itself (an exit code or
  // signal: `exit`, or a server that logs idle shells out with TMOUT), or the connection was lost
  // (an error, the server ending it, no answer to keepalives).
  function traceShellEnd(sessionId, config, stream, conn) {
    const name = (config && config.name) || sessionId;
    const startedAt = Date.now();
    const since = () => `${Math.round((Date.now() - startedAt) / 1000)}s`;
    stream.on('exit', (code, signal) => console.log(`[ssh-end] ${name}: shell exited after ${since()} (code=${code}, signal=${signal || '-'})`));
    stream.on('close', () => console.log(`[ssh-end] ${name}: shell channel closed after ${since()}`));
    conn.on('error', (err) => console.log(`[ssh-end] ${name}: connection error after ${since()}: ${err && err.level ? `${err.level} ` : ''}${err && err.message}`));
    conn.on('end', () => console.log(`[ssh-end] ${name}: the server ended the connection after ${since()}`));
    conn.on('close', () => console.log(`[ssh-end] ${name}: connection closed after ${since()}`));
  }

  const SHELL_EXIT_MESSAGE = '셸이 종료되었습니다. exit 를 입력했거나, 서버가 입력 없는 셸을 자동으로 로그아웃시킨 경우입니다(TMOUT). 계속 쓰려면 재연결을 누르세요.';

  /**
   * Whether the shell ended by itself with an exit status (`exit`, a server's idle auto-logout). That
   * is not a lost connection: reconnecting would only repeat it every few minutes. A shell killed by
   * a signal (the server going down) is still reconnected.
   */
  function endedByItself(shellExit) {
    return Boolean(shellExit) && typeof shellExit.code === 'number' && !shellExit.signal;
  }

  /** The tab is told its shell ended; no automatic reconnect follows (the user presses 재연결) */
  function reportShellExit(sessionId) {
    updateConnectionState(sessionId, ConnectionState.DISCONNECTED);
    const targetWindow = getWindowForSession(sessionId);
    if (targetWindow) {
      targetWindow.webContents.send('ssh-reconnect-failed', { sessionId, message: SHELL_EXIT_MESSAGE });
      targetWindow.webContents.send('ssh-closed', { sessionId });
    }
    endSessionLog(sessionId);
  }

  // Auto-reconnect logic
  async function attemptReconnect(sessionId) {
    const connState = connectionStates.get(sessionId);
    if (!connState || !connState.autoReconnect) {
      return;
    }

    if (connState.retryCount >= 5) {
      updateConnectionState(sessionId, ConnectionState.DISCONNECTED);
      const targetWindow = getWindowForSession(sessionId);
      if (targetWindow) {
        targetWindow.webContents.send('ssh-reconnect-failed', {
          sessionId,
          message: '자동 재연결을 5번 시도했지만 실패했습니다.'
        });
        // Send ssh-closed since reconnection permanently failed
        targetWindow.webContents.send('ssh-closed', { sessionId });
      }
      endSessionLog(sessionId);
      return;
    }

    connState.retryCount++;
    updateConnectionState(sessionId, ConnectionState.RECONNECTING);

    const delay = Math.min(1000 * Math.pow(2, connState.retryCount), 30000); // Max 30s

    const targetWindow = getWindowForSession(sessionId);
    if (targetWindow) {
      targetWindow.webContents.send('ssh-reconnecting', {
        sessionId,
        attempt: connState.retryCount,
        delay,
        maxAttempts: 5
      });
    }

    await new Promise(resolve => setTimeout(resolve, delay));

    // Check if still should reconnect (user might have cancelled)
    const currentState = connectionStates.get(sessionId);
    if (!currentState || currentState.state !== ConnectionState.RECONNECTING) {
      return;
    }

    try {
      await reconnectSession(sessionId);
    } catch (err) {
      if (isHostKeyError(err)) {
        // A different key while reconnecting is a strong sign of interception: stop, and let the user
        // connect again by hand, where the full warning is shown.
        stopReconnectForHostKey(sessionId, err);
        return;
      }
      console.error('Reconnect attempt failed:', err.message);
      // The user may have pressed 재연결 (or closed the tab) meanwhile; only an automatic run goes on
      if (connectionStates.get(sessionId)?.state !== ConnectionState.RECONNECTING) return;
      attemptReconnect(sessionId); // Retry
    }
  }

  function stopReconnectForHostKey(sessionId, err) {
    updateConnectionState(sessionId, ConnectionState.DISCONNECTED);
    const targetWindow = getWindowForSession(sessionId);
    if (targetWindow) {
      targetWindow.webContents.send('ssh-reconnect-failed', { sessionId, message: hostKeyFailureText(err) });
      targetWindow.webContents.send('ssh-closed', { sessionId });
    }
    endSessionLog(sessionId);
  }

  async function reconnectSession(sessionId) {
    const connState = connectionStates.get(sessionId);
    if (!connState || !connState.config) {
      throw new Error('No config available for reconnection');
    }
    // Never asks: nobody may be watching while the app reconnects in the background
    return withHostKeyCheck({ store: hostKeyStore }, (verifierFor) => reconnectOnce(sessionId, connState, verifierFor));
  }

  function reconnectOnce(sessionId, connState, verifierFor) {
    return new Promise((resolve, reject) => {
      const conn = new Client();
      const config = connState.config;

      conn.on('ready', () => {
        conn.shell({ term: 'xterm-256color', cols: 80, rows: 24 }, (err, stream) => {
          if (err) {
            conn.end();
            return reject(err);
          }
          // The user pressed 재연결 while this automatic attempt was connecting: that connection wins
          if (connectionStates.get(sessionId) !== connState || connState.state !== ConnectionState.RECONNECTING) {
            conn.end();
            return reject(new Error('Superseded by a manual reconnect'));
          }

          // Clean up old connection if exists
          // (only this tab's channel when the old connection is shared with a tab made from a split shell)
          const oldConn = sshConnections.get(sessionId);
          closeSftpSession(sessionId);
          if (oldConn) sharedConn.release(sshConnections, sessionId, oldConn);

          const session = { conn, stream };
          sshConnections.set(sessionId, session);
          setupRemoteForwardHandler(sessionId, conn);
          connState.retryCount = 0;
          updateConnectionState(sessionId, ConnectionState.CONNECTED);

          if (ctx.sessionLogger) ctx.sessionLogger.note(sessionId, '재연결됨');

          stream.on('data', (data) => {
            if (ctx.sessionLogger) ctx.sessionLogger.write(sessionId, data);
            // A phone following this tab (remote access) gets the same output
            ctx.tabOutput?.record(sessionId, data);
            const targetWindow = getWindowForSession(sessionId);
            if (targetWindow) {
              targetWindow.webContents.send('ssh-data', { sessionId, data: data.toString() });
            }
          });

          traceShellEnd(sessionId, config, stream, conn);
          let shellExit = null;
          stream.on('exit', (code, signal) => { shellExit = { code, signal }; });
          stream.on('close', () => {
            // A shell replaced by a newer connection (the tab's 재연결) closing late must not touch the new one
            if (sshConnections.get(sessionId) !== session) return;
            if (endedByItself(shellExit)) return reportShellExit(sessionId);
            updateConnectionState(sessionId, ConnectionState.DISCONNECTED);
            attemptReconnect(sessionId);
          });

          const reconnectWindow = getWindowForSession(sessionId);
          if (reconnectWindow) {
            reconnectWindow.webContents.send('ssh-reconnected', { sessionId });
          }
          // Back to root after an automatic reconnect too; a failure shows in the terminal itself
          if (config.suRoot && config.suPassword) void switchToRoot(stream, { password: config.suPassword });

          resolve();
        });
      });

      conn.on('error', (err) => {
        reject(err);
      });

      // Build connect config
      const connectOpts = {
        host: config.host,
        port: config.port || 22,
        username: config.username,
        keepaliveInterval: config.keepaliveInterval || 30000,
        keepaliveCountMax: 3,
        readyTimeout: config.connectTimeout || 20000,
        algorithms: SSH_ALGORITHMS,
        hostVerifier: verifierFor(config.host, config.port || 22)
      };

      if (config.authType === 'privateKey') {
        try {
          connectOpts.privateKey = readPrivateKeyFile(config.privateKeyPath);
          if (config.passphrase) {
            connectOpts.passphrase = config.passphrase;
          }
        } catch (err) {
          return reject(new Error('Private Key 파일을 읽을 수 없습니다: ' + err.message));
        }
      } else if (config.password) {
        connectOpts.password = config.password;
      }

      conn.connect(connectOpts);
    });
  }

  // SSH 연결 테스트 (세션 모달): 인증까지만 확인하고 바로 연결을 닫는다
  ipcMain.handle('ssh-test-connection', async (event, config) => {
    try {
      return await checkHostKeyAsking((verifierFor) => testSshConnection(config, { verifierFor }));
    } catch (err) {
      if (isHostKeyError(err)) {
        const { host, port } = err.info;
        const isJump = Boolean(config && config.useJumpHost && config.jumpHost)
          && host === config.jumpHost.trim() && port === (Number(config.jumpPort) || 22);
        return { success: false, stage: isJump ? 'jump' : 'target', ...hostKeyMessage(err) };
      }
      console.error('SSH connection test failed unexpectedly:', err);
      return { success: false, stage: 'target', error: '연결 테스트 중 오류가 발생했습니다.', detail: err.message };
    }
  });

  // SSH 연결
  ipcMain.handle('ssh-connect', async (event, rawConfig) => {
    const sessionId = Date.now().toString();
    // A host saved with a space around it reached ssh2 as-is and failed with "getaddrinfo ENOTFOUND".
    // The trimmed config is also what reconnects use (connectionStates keeps it).
    const config = normalizeConnectConfig(rawConfig);
    try {
      return await checkHostKeyAsking((verifierFor) => openShellConnection(sessionId, config, verifierFor));
    } catch (err) {
      if (isHostKeyError(err)) return { success: false, error: hostKeyFailureText(err) };
      // The same Korean wording as the connection test, instead of Electron's raw "Error invoking remote method"
      console.error('SSH connect failed:', err);
      const { error, hint } = describeSshError(err);
      return { success: false, error: hint ? `${error} ${hint}` : error };
    }
  });

  function openShellConnection(sessionId, config, verifierFor) {
    return new Promise((resolve, reject) => {
      const connectFinalHost = (sock) => {
        const conn = new Client();
        let opened = false;

        conn.on('ready', () => {
          conn.shell({ term: 'xterm-256color', cols: 80, rows: 24 }, (err, stream) => {
            if (err) {
              reject(err);
              return;
            }
            const session = { conn, stream, jumpConn: sock ? sock._client : null };
            sshConnections.set(sessionId, session);
            setupRemoteForwardHandler(sessionId, conn);

            // Store connection state for reconnection
            connectionStates.set(sessionId, {
              state: ConnectionState.CONNECTED,
              config: { ...config },
              retryCount: 0,
              autoReconnect: config.autoReconnect !== false
            });

            stream.on('data', (data) => {
              if (ctx.sessionLogger) ctx.sessionLogger.write(sessionId, data);
              // A phone following this tab (remote access) gets the same output
              ctx.tabOutput?.record(sessionId, data);
              const targetWindow = getWindowForSession(sessionId);
              if (targetWindow) {
                targetWindow.webContents.send('ssh-data', {
                  sessionId,
                  data: data.toString('utf-8')
                });
              }
            });

            traceShellEnd(sessionId, config, stream, conn);
            let shellExit = null;
            stream.on('exit', (code, signal) => { shellExit = { code, signal }; });
            stream.on('close', () => {
              // A shell replaced by a newer connection (the tab's 재연결) or closed with its tab is not this tab's news
              if (sshConnections.get(sessionId) !== session) return;
              const connState = connectionStates.get(sessionId);
              if (endedByItself(shellExit)) return reportShellExit(sessionId);

              // If auto-reconnect is enabled, don't send ssh-closed yet - let reconnection handle it
              if (connState && connState.autoReconnect) {
                updateConnectionState(sessionId, ConnectionState.RECONNECTING);
                attemptReconnect(sessionId);
              } else {
                // No auto-reconnect, send ssh-closed immediately
                const targetWindow = getWindowForSession(sessionId);
                if (targetWindow) {
                  targetWindow.webContents.send('ssh-closed', { sessionId });
                }
                updateConnectionState(sessionId, ConnectionState.DISCONNECTED);
                endSessionLog(sessionId);
              }
            });

            opened = true;
            // "로그인 후 root 로 전환": su before answering, so the post-connect script runs as root.
            // Only the outcome goes back to the window, never the password.
            if (config.suRoot && config.suPassword) {
              switchToRoot(stream, { password: config.suPassword })
                .then(({ outcome }) => resolve({ success: true, sessionId, rootSwitch: outcome }));
            } else {
              resolve({ success: true, sessionId });
            }
          });
        });

        conn.on('error', (err) => {
          // A target that failed before the shell opened (refused host key included) leaves no use for the tunnel
          if (!opened && sock && sock._client) {
            try { sock._client.end(); } catch (e) { /* already closed */ }
          }
          // Only reject if Promise hasn't resolved yet
          reject(err);
        });

        // Handle connection-level close (covers cases where connection drops without stream close)
        conn.on('close', () => {
          const connState = connectionStates.get(sessionId);
          // Only handle if this connection is still the active one
          const currentSession = sshConnections.get(sessionId);
          if (currentSession && currentSession.conn === conn) {
            // DISCONNECTED: the shell ended by itself, or reconnecting was given up; the user decides
            if (connState && connState.autoReconnect && connState.state !== ConnectionState.RECONNECTING && connState.state !== ConnectionState.DISCONNECTED) {
              updateConnectionState(sessionId, ConnectionState.RECONNECTING);
              attemptReconnect(sessionId);
            }
          }
        });

        // 연결 설정 구성
        const connectConfig = {
          host: config.host,
          port: config.port || 22,
          username: config.username,
          keepaliveInterval: config.keepaliveInterval || 30000,
          keepaliveCountMax: 3,
          readyTimeout: config.connectTimeout || 20000,
          algorithms: SSH_ALGORITHMS,
          hostVerifier: verifierFor(config.host, config.port || 22)
        };

        // sock이 있으면 Jump Host 터널 사용
        if (sock) {
          connectConfig.sock = sock;
        }

        // 인증 방식에 따른 설정
        if (config.authType === 'privateKey' && config.privateKeyPath) {
          try {
            connectConfig.privateKey = readPrivateKeyFile(config.privateKeyPath);
            if (config.passphrase) {
              connectConfig.passphrase = config.passphrase;
            }
          } catch (err) {
            reject(new Error('Private Key 파일을 읽을 수 없습니다: ' + err.message));
            return;
          }
        } else {
          connectConfig.password = config.password;
        }

        conn.connect(connectConfig);
      };

      // Jump Host 사용 여부 확인
      if (config.useJumpHost && config.jumpHost) {
        const jumpConn = new Client();

        jumpConn.on('ready', () => {
          // Jump Host를 통해 최종 호스트로 TCP 터널 생성
          jumpConn.forwardOut('127.0.0.1', 0, config.host, config.port || 22, (err, stream) => {
            if (err) {
              jumpConn.end();
              reject(new Error('Jump Host 터널 생성 실패: ' + err.message));
              return;
            }
            // 터널 스트림에 _client 참조 저장 (나중에 정리용)
            stream._client = jumpConn;
            connectFinalHost(stream);
          });
        });

        jumpConn.on('error', (err) => {
          reject(new Error('Jump Host 연결 실패: ' + err.message));
        });

        // Jump Host 연결 설정
        const jumpConfig = {
          host: config.jumpHost,
          port: config.jumpPort || 22,
          username: config.jumpUsername || config.username,
          keepaliveInterval: 30000,
          keepaliveCountMax: 3,
          readyTimeout: config.connectTimeout || 20000,
          algorithms: SSH_ALGORITHMS,
          hostVerifier: verifierFor(config.jumpHost, config.jumpPort || 22)
        };

        if (config.jumpAuthType === 'privateKey' && config.jumpPrivateKeyPath) {
          try {
            jumpConfig.privateKey = readPrivateKeyFile(config.jumpPrivateKeyPath);
            if (config.jumpPassphrase) {
              jumpConfig.passphrase = config.jumpPassphrase;
            }
          } catch (err) {
            reject(new Error('Jump Host Private Key 파일을 읽을 수 없습니다: ' + err.message));
            return;
          }
        } else {
          jumpConfig.password = config.jumpPassword;
        }

        jumpConn.connect(jumpConfig);
      } else {
        // Jump Host 없이 직접 연결
        connectFinalHost(null);
      }
    });
  }

  // Answer from the host key dialog: only the request id and a decision, never a key or fingerprint
  ipcMain.on('host-key-respond', (event, payload) => {
    if (!ctx.mainWindow || ctx.mainWindow.isDestroyed() || event.sender !== ctx.mainWindow.webContents) return;
    if (!payload || typeof payload.id !== 'string') return;
    hostKeyPrompter.respond(payload.id, payload.decision);
  });

  // SSH 데이터 전송
  ipcMain.on('ssh-send', (event, { sessionId, data }) => {
    const session = sshConnections.get(sessionId);
    if (session && session.stream) {
      session.stream.write(data);
    }
  });

  // SSH 터미널 리사이즈
  ipcMain.on('ssh-resize', (event, { sessionId, cols, rows }) => {
    const session = sshConnections.get(sessionId);
    if (session && session.stream) {
      session.stream.setWindow(rows, cols, 0, 0);
    }
    // Remembered even when no log is running, so a log started later uses the real width
    if (session) getSessionLogger().resize(sessionId, cols, rows);
    // A phone following the tab draws it at the PC's size (it never resizes the tab itself)
    if (session) ctx.tabOutput?.resize(sessionId, cols, rows);
  });

  // SSH 명령어 실행 (단일 명령어, 결과 반환)
  ipcMain.handle('ssh-exec-command', async (event, { sessionId, command }) => {
    const session = sshConnections.get(sessionId);
    if (!session || !session.conn) {
      return { success: false, error: 'Session not connected' };
    }

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve({ success: false, error: 'Command timeout' });
      }, 10000);

      session.conn.exec(command, (err, stream) => {
        if (err) {
          clearTimeout(timeout);
          resolve({ success: false, error: err.message });
          return;
        }

        let stdout = '';
        let stderr = '';

        stream.on('data', (data) => {
          stdout += data.toString('utf-8');
        });

        stream.stderr.on('data', (data) => {
          stderr += data.toString('utf-8');
        });

        stream.on('close', (code) => {
          clearTimeout(timeout);
          resolve({ success: true, stdout, stderr, exitCode: code });
        });
      });
    });
  });

  // SSH 연결 종료
  ipcMain.on('ssh-disconnect', (event, { sessionId }) => {
    endSessionLog(sessionId);
    ctx.tabOutput?.ended(sessionId, 'closed');
    containers.forget(sessionId);
    closeSftpSession(sessionId);
    const session = sshConnections.get(sessionId);
    if (session) {
      // Off the list first: the shell's late close event then sees it is not this tab's news
      sshConnections.delete(sessionId);
      // The connection (and its jump host) ends unless a tab made from one of its split shells still
      // uses it; then only this tab's shell closes and the connection ends with the last such tab
      sharedConn.release(sshConnections, sessionId, session);
    }

    // Clean up any split terminal streams (close(), not end(): on a connection that stays open a PTY
    // shell would ignore the EOF and remain on the server)
    for (const [key, stream] of sshStreams.entries()) {
      if (key.startsWith(sessionId + ':')) {
        try { stream.close(); } catch (e) {}
        sshStreams.delete(key);
        splitStreamHandlers.delete(key);
      }
    }

    // Clean up port forwards
    cleanupPortForwards(sessionId);

    // Cancel auto-reconnect
    const connState = connectionStates.get(sessionId);
    if (connState) {
      connState.autoReconnect = false;
      connState.state = ConnectionState.DISCONNECTED;
      connectionStates.delete(sessionId);
    }
  });

  // Session log: start / stop for one tab, the tabs being logged, and the log folder
  ipcMain.handle('session-log-start', (event, payload) => {
    const { sessionId, name } = payload || {};
    if (typeof sessionId !== 'string' || !sshConnections.has(sessionId)) {
      return { success: false, error: '연결된 탭에서만 로그를 저장할 수 있습니다.' };
    }
    const result = getSessionLogger().start(sessionId, typeof name === 'string' ? name.slice(0, MAX_SESSION_LOG_NAME) : '');
    if (result.success) notifySessionLog(sessionId, { isLogging: true, filePath: result.filePath });
    return result;
  });

  ipcMain.handle('session-log-stop', async (event, payload) => {
    const { sessionId } = payload || {};
    if (typeof sessionId !== 'string') return { success: false, error: '탭을 찾을 수 없습니다.' };
    const result = await getSessionLogger().stop(sessionId);
    notifySessionLog(sessionId, { isLogging: false, filePath: result.filePath });
    return result;
  });

  ipcMain.handle('session-log-list', () => ({ success: true, items: ctx.sessionLogger ? ctx.sessionLogger.list() : [] }));

  ipcMain.handle('session-log-open-folder', async () => {
    try {
      const dir = sessionLogDir();
      fs.mkdirSync(dir, { recursive: true });
      const failure = await shell.openPath(dir);
      return failure ? { success: false, error: '로그 폴더를 열 수 없습니다.' } : { success: true };
    } catch (err) {
      console.error('Failed to open the session log folder:', err);
      return { success: false, error: '로그 폴더를 열 수 없습니다.' };
    }
  });


  // Cancel reconnection
  // "재연결" on a dropped tab: connect again the way the tab first connected (jump host included), under the
  // same session id so the tab's terminal carries on. The user pressed it, so a changed host key is asked about.
  ipcMain.handle('ssh-reconnect-now', async (event, payload) => {
    const sessionId = payload && typeof payload.sessionId === 'string' ? payload.sessionId : '';
    const connState = sessionId ? connectionStates.get(sessionId) : null;
    if (!connState || !connState.config) {
      return { success: false, error: '다시 연결할 접속 정보가 없습니다. 탭을 닫고 새로 접속하세요.' };
    }
    if (ctx.isAppLocked) return { success: false, error: '앱 잠금을 해제하세요.' };
    // An automatic attempt waiting for its turn sees the state change and gives up
    connState.state = ConnectionState.CONNECTING;
    // Take the old connection off the list first: its late close events then see they are not current
    const old = sshConnections.get(sessionId);
    closeSftpSession(sessionId);
    if (old) {
      sshConnections.delete(sessionId);
      // Only this tab's shell when a tab made from a split shell still uses the old connection
      sharedConn.release(sshConnections, sessionId, old);
    }
    try {
      const result = await checkHostKeyAsking((verifierFor) => openShellConnection(sessionId, connState.config, verifierFor));
      if (ctx.sessionLogger) ctx.sessionLogger.note(sessionId, '재연결됨');
      return result.rootSwitch ? { success: true, rootSwitch: result.rootSwitch } : { success: true };
    } catch (err) {
      // The saved config stays, so the user can press 재연결 again
      connState.state = ConnectionState.DISCONNECTED;
      if (isHostKeyError(err)) return { success: false, error: hostKeyFailureText(err) };
      return { success: false, error: describeSshError(err).error };
    }
  });

  ipcMain.handle('ssh-cancel-reconnect', (event, { sessionId }) => {
    const connState = connectionStates.get(sessionId);
    if (connState) {
      connState.autoReconnect = false;
      connState.state = ConnectionState.DISCONNECTED;
    }
    return { success: true };
  });


  return { attemptReconnect, endedByItself, reportShellExit };
}

module.exports = { registerSshSessionIpc };
