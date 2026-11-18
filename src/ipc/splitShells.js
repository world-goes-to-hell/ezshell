// Split shells: extra shell channels on a tab's SSH connection (one per pane), and handing one over
// to become a tab of its own (ssh-adopt-split). Moved out of main.js as it was.
//
// An adopted shell is a tab's main shell from then on, so its close is handled the way main.js
// handles a tab's: the functions for that (reconnect, shell exit report, session log) are handed in.

const sharedConn = require('../sharedConn.js');

function registerSplitShellIpc(ctx) {
  const { ipcMain, sshConnections, sshStreams, splitStreamHandlers, connectionStates, ConnectionState, updateConnectionState, getWindowForSession, fromMainWindow, attemptReconnect, endedByItself, reportShellExit, endSessionLog, portForwardCount, containers, closeSftpSession } = ctx;

  const splitStreamLastClosed = new Map(); // sessionId -> timestamp of last split stream close

  let splitStreamSeq = 0;
  const tabBindings = new WeakMap();
  const heldPromotions = new Map();

  // Diagnostics for "Channel open failure": how many channels this SSH connection holds open.
  // Reads ssh2's internal channel manager, so it degrades to '?' if that ever changes.
  function openChannelCount(conn) {
    const mgr = conn && conn._chanMgr;
    return mgr && typeof mgr._count === 'number' ? mgr._count : '?';
  }

  function describeChannels(conn) {
    const total = openChannelCount(conn);
    if (typeof total !== 'number') return '';
    const label = `SSH 연결 채널 ${total}개`;
    const channels = Object.values(conn._chanMgr._channels || {});
    if (!total || channels.length !== total) return label;
    const counts = { '셸': 0, SFTP: 0, '여는 중': 0, '닫는 중': 0, '기타': 0 };
    for (const channel of channels) {
      if (typeof channel === 'function') counts['여는 중']++;
      else if (channel?.outgoing?.state === 'closing') counts['닫는 중']++;
      else if (channel?.subtype === 'shell') counts['셸']++;
      else if (channel?.constructor?.name === 'SFTP') counts.SFTP++;
      else counts['기타']++;
    }
    const detail = Object.entries(counts).filter(([, count]) => count > 0).map(([name, count]) => `${name} ${count}`);
    return [label, ...detail].join(' · ');
  }

  // A shell channel becomes a split shell of the tab `sessionId`: its output and its end go out
  // under `streamId`. `conn` is only for the channel count in the log.
  function attachSplitStream(sessionId, streamId, stream, conn) {
    sshStreams.set(streamId, stream);
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
      console.log(`[split] closed ${streamId} openChannels=${openChannelCount(conn)}`);
      // A merged tab's shell on a connection of its own: the connection ends with it
      const released = sharedConn.releaseGuest(sshConnections, stream);
      if (released === 'connection') console.log(`[split] ${streamId} was the last user of its connection: ended`);
      const targetWindow = getWindowForSession(sessionId);
      if (targetWindow) {
        targetWindow.webContents.send('ssh-split-closed', { streamId, sessionId });
      }
    };
    stream.on('data', onData);
    stream.on('close', onClose);
    splitStreamHandlers.set(streamId, { onData, onClose });
  }

  function takeSplit(streamId) {
    const stream = sshStreams.get(streamId);
    const handlers = splitStreamHandlers.get(streamId);
    stream.off('data', handlers.onData);
    stream.off('close', handlers.onClose);
    sshStreams.delete(streamId);
    splitStreamHandlers.delete(streamId);
    return stream;
  }

  function stopTabOutput(stream) {
    tabBindings.get(stream)?.();
    // The connection's original data listener sends output under the old tab id.
    stream.removeAllListeners('data');
  }

  function bindTabStream(sessionId, session) {
    const { stream } = session;
    sshConnections.set(sessionId, session);
    const onData = (data) => {
      if (ctx.sessionLogger) ctx.sessionLogger.write(sessionId, data);
      const targetWindow = getWindowForSession(sessionId);
      if (targetWindow) targetWindow.webContents.send('ssh-data', { sessionId, data: data.toString('utf-8') });
    };
    let shellExit = null;
    const onExit = (code, signal) => { shellExit = { code, signal }; };
    const onClose = () => {
      unbind();
      sharedConn.releaseGuest(sshConnections, stream);
      if (sshConnections.get(sessionId) !== session) return;
      if (endedByItself(shellExit)) return reportShellExit(sessionId);
      const connState = connectionStates.get(sessionId);
      if (connState?.autoReconnect) {
        updateConnectionState(sessionId, ConnectionState.RECONNECTING);
        attemptReconnect(sessionId);
      } else {
        const targetWindow = getWindowForSession(sessionId);
        if (targetWindow) targetWindow.webContents.send('ssh-closed', { sessionId });
        updateConnectionState(sessionId, ConnectionState.DISCONNECTED);
        endSessionLog(sessionId);
      }
    };
    const unbind = () => {
      stream.off('data', onData);
      stream.off('exit', onExit);
      stream.off('close', onClose);
      tabBindings.delete(stream);
      const held = heldPromotions.get(sessionId);
      if (held?.stream === stream) {
        clearTimeout(held.timer);
        heldPromotions.delete(sessionId);
      }
    };
    tabBindings.set(stream, unbind);
    stream.on('data', onData);
    stream.on('exit', onExit);
    stream.on('close', onClose);
  }

  function newTab(stream, transport, ownerState) {
    const sessionId = sharedConn.newSessionId(sshConnections);
    connectionStates.set(sessionId, {
      state: ConnectionState.CONNECTED,
      config: { ...ownerState.config },
      retryCount: 0,
      autoReconnect: ownerState.autoReconnect
    });
    bindTabStream(sessionId, { conn: transport.conn, stream, jumpConn: transport.jumpConn || null });
    // The new tab's connection record now keeps this transport alive on its own.
    sharedConn.releaseGuest(sshConnections, stream);
    return sessionId;
  }

  function resumePromotion(ownerId, streamId) {
    const held = heldPromotions.get(ownerId);
    if (!held || held.streamId !== streamId) return;
    heldPromotions.delete(ownerId);
    clearTimeout(held.timer);
    held.stream.resume();
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
            const detail = describeChannels(session.conn);
            console.warn(`[split] open failed session=${sessionId} ${detail}: ${err.message}`);
            return resolve({ success: false, error: detail ? `${err.message} (${detail})` : err.message });
          }

          // Several split shells can open in the same millisecond (quad layout),
          // and a shared id makes all panes write to and render the same stream
          const streamId = `${sessionId}:split-${Date.now()}-${++splitStreamSeq}`;
          attachSplitStream(sessionId, streamId, stream, session.conn);
          console.log(`[split] opened ${streamId} openChannels=${openChannelCount(session.conn)}`);

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
    if (!stream || stream.destroyed || !handlers || !owner || !ownerState?.config) {
      return { success: false, error: '옮길 셸을 찾지 못했습니다.' };
    }

    const sessionId = newTab(takeSplit(streamId), sharedConn.guestOf(stream) || owner, ownerState);
    console.log(`[split] ${streamId} became tab ${sessionId} openChannels=${openChannelCount(owner.conn)}`);
    return { success: true, sessionId };
  });

  // Promote an existing pane while the previous main shell is detached or closed. The original tab
  // id and transport stay in place for SFTP, forwarding and any other panes using that tab.
  ipcMain.handle('ssh-promote-pane', (event, payload) => {
    if (!fromMainWindow(event) || ctx.isAppLocked) return { success: false, error: '본창에서 앱 잠금을 해제한 뒤 다시 시도해 주세요.' };
    const { sessionId, streamId, closePrevious } = payload || {};
    if (typeof sessionId !== 'string' || typeof streamId !== 'string' || !streamId.startsWith(`${sessionId}:`)) {
      return { success: false, error: '옮길 셸을 찾지 못했습니다.' };
    }
    const owner = sshConnections.get(sessionId);
    const ownerState = connectionStates.get(sessionId);
    const promoted = sshStreams.get(streamId);
    if (!owner?.stream || owner.stream.destroyed || !ownerState?.config || ownerState.state !== ConnectionState.CONNECTED ||
        !promoted || promoted.destroyed || !splitStreamHandlers.has(streamId) || heldPromotions.has(sessionId)) {
      return { success: false, error: '두 셸이 연결된 상태에서 다시 시도해 주세요.' };
    }
    // Wait until the renderer has drawn the two old streams and replaced the original tab's screen.
    promoted.pause();
    takeSplit(streamId);
    stopTabOutput(owner.stream);
    const newId = closePrevious === true ? undefined : newTab(owner.stream, sharedConn.guestOf(owner.stream) || owner, ownerState);
    bindTabStream(sessionId, { ...owner, stream: promoted });
    const timer = setTimeout(() => resumePromotion(sessionId, streamId), 10000);
    timer.unref();
    heldPromotions.set(sessionId, { streamId, stream: promoted, timer });
    if (closePrevious === true) {
      splitStreamLastClosed.set(sessionId, Date.now());
      // The old channel can be on a separate connection if it was promoted from a merged tab.
      const release = () => sharedConn.releaseGuest(sshConnections, owner.stream);
      if (sharedConn.guestOf(owner.stream)) owner.stream.once('close', release);
      try { owner.stream.close(); } catch { release(); }
    }
    return { success: true, sessionId: newId };
  });

  ipcMain.on('ssh-resume-promoted-pane', (event, { sessionId, streamId } = {}) => {
    if (fromMainWindow(event)) resumePromotion(sessionId, streamId);
  });

  // The other way round: a tab becomes a pane of another tab, with its shell as it is. The tab's
  // session goes away and its shell channel is from then on a split shell of the target tab.
  // Only between tabs of the same account on the same server, and only a plain tab: one that is
  // itself divided, or holds port forwards, is refused. The window names two open tabs and nothing else.
  const MAX_SPLIT_SHELLS = 5; // six panes per tab, the first being the tab's own shell (lib/splitTree.ts)
  ipcMain.handle('ssh-merge-tab', (event, payload) => {
    if (!fromMainWindow(event)) return { success: false, error: '본창에서만 할 수 있습니다.' };
    if (ctx.isAppLocked) return { success: false, error: '앱 잠금을 해제하세요.' };
    const sourceId = payload && typeof payload.sourceId === 'string' ? payload.sourceId : '';
    const targetId = payload && typeof payload.targetId === 'string' ? payload.targetId : '';
    const source = sshConnections.get(sourceId);
    const target = sshConnections.get(targetId);
    const sourceState = connectionStates.get(sourceId);
    const targetState = connectionStates.get(targetId);
    if (!sourceId || sourceId === targetId || !source || !target || !sourceState || !targetState) {
      return { success: false, error: '병합할 탭을 찾지 못했습니다.' };
    }
    const isLive = (session, state) => state.state === ConnectionState.CONNECTED && session.conn && session.stream && !session.stream.destroyed;
    if (!isLive(source, sourceState) || !isLive(target, targetState)) {
      return { success: false, error: '연결된 탭끼리만 병합할 수 있습니다.' };
    }
    if (source.conn !== target.conn && !sharedConn.sameServer(sourceState.config, targetState.config)) {
      return { success: false, error: '다른 세션의 탭은 병합할 수 없습니다.' };
    }
    const splitsOf = (id) => [...sshStreams.keys()].filter(key => key.startsWith(id + ':')).length;
    if (splitsOf(sourceId) > 0) return { success: false, error: '칸을 나눈 탭은 병합할 수 없습니다.' };
    if (splitsOf(targetId) >= MAX_SPLIT_SHELLS) return { success: false, error: '한 탭에는 6칸까지 둘 수 있습니다.' };
    if (portForwardCount(sourceId) > 0) return { success: false, error: '포트 포워딩을 쓰는 탭은 병합할 수 없습니다.' };

    const stream = source.stream;
    // The tab's session ends here, the way a closed tab's does, except that its shell stays open.
    // Off the list first: the shell's close handlers then see it is no longer that tab's shell.
    endSessionLog(sourceId);
    containers.forget(sourceId);
    closeSftpSession(sourceId);
    sshConnections.delete(sourceId);
    sourceState.autoReconnect = false;
    connectionStates.delete(sourceId);
    // Its output stops going out as the tab's
    stopTabOutput(stream);
    // On a connection of its own, nothing else holds that connection now: it stays until the shell closes
    const transport = sharedConn.guestOf(stream) || source;
    if (transport.conn !== target.conn) sharedConn.addGuest(stream, transport.conn, transport.jumpConn);
    else sharedConn.releaseGuest(sshConnections, stream);
    if (transport.conn !== source.conn && !sharedConn.isShared(sshConnections, source.conn, null)) sharedConn.endTransport(source);

    const streamId = `${targetId}:split-${Date.now()}-${++splitStreamSeq}`;
    attachSplitStream(targetId, streamId, stream, transport.conn);
    console.log(`[split] tab ${sourceId} became ${streamId} openChannels=${openChannelCount(source.conn)}`);
    return { success: true, streamId };
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
