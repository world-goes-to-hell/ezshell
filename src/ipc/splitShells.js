// Split shells: extra shell channels on a tab's SSH connection (one per pane), and handing one over
// to become a tab of its own (ssh-adopt-split). Moved out of main.js as it was.
//
// An adopted shell is a tab's main shell from then on, so its close is handled the way main.js
// handles a tab's: the functions for that (reconnect, shell exit report, session log) are handed in.

const sharedConn = require('../sharedConn.js');

function registerSplitShellIpc(ctx) {
  const { ipcMain, sshConnections, sshStreams, splitStreamHandlers, connectionStates, ConnectionState, updateConnectionState, getWindowForSession, fromMainWindow, attemptReconnect, endedByItself, reportShellExit, endSessionLog } = ctx;

  const splitStreamLastClosed = new Map(); // sessionId -> timestamp of last split stream close

  let splitStreamSeq = 0;

  // Diagnostics for "Channel open failure": how many channels this SSH connection holds open.
  // Reads ssh2's internal channel manager, so it degrades to '?' if that ever changes.
  function openChannelCount(conn) {
    const mgr = conn && conn._chanMgr;
    return mgr && typeof mgr._count === 'number' ? mgr._count : '?';
  }

  // Create new shell for split terminal (uses same SSH connection)
  ipcMain.handle('ssh-create-shell', async (event, { sessionId }) => {
    const session = sshConnections.get(sessionId);
    if (!session || !session.conn) {
      return { success: false, error: 'SSH 연결이 없습니다.' };
    }

    // Do not close existing split streams here: every stream in sshStreams is live
    // (renderer closes them on unmount, and 'close' removes them), and quad/tri
    // layouts create several split shells for the same session in parallel.

    // Wait if a split stream was closed recently - the server needs time to
    // fully process the channel closure before accepting a new channel
    const lastClosed = splitStreamLastClosed.get(sessionId);
    const timeSinceClose = lastClosed ? Date.now() - lastClosed : Infinity;
    if (timeSinceClose < 1000) {
      const waitTime = Math.max(500, 1000 - timeSinceClose);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }

    const createShell = () => {
      return new Promise((resolve) => {
        session.conn.shell({ term: 'xterm-256color', cols: 80, rows: 24 }, (err, stream) => {
          if (err) {
            const count = openChannelCount(session.conn);
            console.warn(`[split] open failed session=${sessionId} openChannels=${count}: ${err.message}`);
            return resolve({ success: false, error: `${err.message} (열린 채널 ${count}개)` });
          }

          // Several split shells can open in the same millisecond (quad layout),
          // and a shared id makes all panes write to and render the same stream
          const streamId = `${sessionId}:split-${Date.now()}-${++splitStreamSeq}`;
          sshStreams.set(streamId, stream);
          console.log(`[split] opened ${streamId} openChannels=${openChannelCount(session.conn)}`);

          const onData = (data) => {
            const targetWindow = getWindowForSession(sessionId);
            if (targetWindow) {
              targetWindow.webContents.send('ssh-split-data', {
                streamId,
                sessionId,
                data: data.toString('utf-8')
              });
            }
          };
          const onClose = () => {
            sshStreams.delete(streamId);
            splitStreamHandlers.delete(streamId);
            console.log(`[split] closed ${streamId} openChannels=${openChannelCount(session.conn)}`);
            const targetWindow = getWindowForSession(sessionId);
            if (targetWindow) {
              targetWindow.webContents.send('ssh-split-closed', { streamId, sessionId });
            }
          };
          stream.on('data', onData);
          stream.on('close', onClose);
          splitStreamHandlers.set(streamId, { onData, onClose });

          resolve({ success: true, streamId });
        });
      });
    };

    let result = await createShell();

    // If channel open still failed, retry once (fallback safety)
    if (!result.success && result.error && result.error.includes('Channel open failure')) {
      await new Promise(resolve => setTimeout(resolve, 500));
      result = await createShell();
    }

    return result;
  });

  // A split shell becomes a tab of its own, as it is: the same channel on the same SSH connection gets
  // a session id, so everything that works per tab (SFTP, more splits, log, duplicate, reconnect) works
  // for it. The window names an open split shell and nothing else; the connection and the login come
  // from the tab the shell was split from.
  ipcMain.handle('ssh-adopt-split', (event, payload) => {
    if (!fromMainWindow(event)) return { success: false, error: '본창에서만 할 수 있습니다.' };
    if (ctx.isAppLocked) return { success: false, error: '앱 잠금을 해제하세요.' };
    const streamId = payload && typeof payload.streamId === 'string' ? payload.streamId : '';
    const stream = sshStreams.get(streamId);
    const handlers = splitStreamHandlers.get(streamId);
    const ownerId = streamId.split(':')[0];
    const owner = sshConnections.get(ownerId);
    const ownerState = connectionStates.get(ownerId);
    if (!stream || !handlers || !owner || !ownerState || !ownerState.config) {
      return { success: false, error: '옮길 셸을 찾지 못했습니다.' };
    }

    const sessionId = sharedConn.newSessionId(sshConnections);
    // From here on the shell is the new tab's: its output goes out as that tab's, and its end is
    // handled like any tab's shell (ended by itself: say so; lost: reconnect with a connection of its own)
    stream.removeListener('data', handlers.onData);
    stream.removeListener('close', handlers.onClose);
    sshStreams.delete(streamId);
    splitStreamHandlers.delete(streamId);
    sshConnections.set(sessionId, { conn: owner.conn, stream, jumpConn: owner.jumpConn || null });
    connectionStates.set(sessionId, {
      state: ConnectionState.CONNECTED,
      config: { ...ownerState.config },
      retryCount: 0,
      autoReconnect: ownerState.autoReconnect
    });

    stream.on('data', (data) => {
      if (ctx.sessionLogger) ctx.sessionLogger.write(sessionId, data);
      const targetWindow = getWindowForSession(sessionId);
      if (targetWindow) targetWindow.webContents.send('ssh-data', { sessionId, data: data.toString('utf-8') });
    });
    let shellExit = null;
    stream.on('exit', (code, signal) => { shellExit = { code, signal }; });
    stream.on('close', () => {
      // Replaced by a reconnect, or closed with its tab: not this tab's news
      if (sshConnections.get(sessionId)?.stream !== stream) return;
      if (endedByItself(shellExit)) return reportShellExit(sessionId);
      const connState = connectionStates.get(sessionId);
      if (connState && connState.autoReconnect) {
        updateConnectionState(sessionId, ConnectionState.RECONNECTING);
        attemptReconnect(sessionId);
      } else {
        const targetWindow = getWindowForSession(sessionId);
        if (targetWindow) targetWindow.webContents.send('ssh-closed', { sessionId });
        updateConnectionState(sessionId, ConnectionState.DISCONNECTED);
        endSessionLog(sessionId);
      }
    });
    console.log(`[split] ${streamId} became tab ${sessionId} openChannels=${openChannelCount(owner.conn)}`);
    return { success: true, sessionId };
  });

  // Send data to split terminal stream
  ipcMain.on('ssh-split-send', (event, { streamId, data }) => {
    const stream = sshStreams.get(streamId);
    if (stream) {
      stream.write(data);
    }
  });

  // Resize split terminal
  ipcMain.on('ssh-split-resize', (event, { streamId, cols, rows }) => {
    const stream = sshStreams.get(streamId);
    if (stream) {
      stream.setWindow(rows, cols, 0, 0);
    }
  });

  // Close split terminal stream
  ipcMain.on('ssh-split-close', (event, { streamId }) => {
    const stream = sshStreams.get(streamId);
    if (stream) {
      // Extract sessionId from streamId (format: "sessionId:split-timestamp-seq")
      const sessionId = streamId.split(':')[0];
      splitStreamLastClosed.set(sessionId, Date.now());
      // end() only sends EOF (ssh2 client channels are half-open by default) and a PTY shell
      // ignores EOF, so the server kept every closed split alive until MaxSessions refused
      // new channels. close() sends CHANNEL_CLOSE and the server ends the session.
      try { stream.close(); } catch (e) {}
      sshStreams.delete(streamId);
      splitStreamHandlers.delete(streamId);
      const session = sshConnections.get(sessionId);
      console.log(`[split] close requested ${streamId} openChannels(before server ack)=${openChannelCount(session && session.conn)}`);
    } else {
      console.warn(`[split] close requested for unknown stream ${streamId}`);
    }
  });
}

module.exports = { registerSplitShellIpc };
