// Port forwarding over a tab's SSH connection: local (-L), remote (-R) and dynamic (-D, SOCKS).
// Moved out of main.js as it was. main.js calls setupRemoteForwardHandler when a connection is
// ready (also after a reconnect) and cleanupPortForwards when a tab disconnects.

const net = require('net');

function registerPortForwardIpc(ctx) {
  const { ipcMain, sshConnections, getWindowForSession } = ctx;

  const portForwards = new Map(); // forwardId -> { type, server, sessionId, localHost, localPort, remoteHost, remotePort, connectionCount }

  // ==================== 포트 포워딩 기능 ====================

  // Local port forwarding (-L): localHost:localPort -> remoteHost:remotePort via SSH
  ipcMain.handle('port-forward-local', async (event, { sessionId, localPort, remoteHost, remotePort, localHost }) => {
    const session = sshConnections.get(sessionId);
    if (!session || !session.conn) {
      return { success: false, error: 'SSH 연결이 없습니다.' };
    }

    const bindHost = localHost || '127.0.0.1';
    const forwardId = `local-${sessionId}-${localPort}`;

    // Check if already exists
    if (portForwards.has(forwardId)) {
      return { success: false, error: `포트 ${localPort}이(가) 이미 포워딩 중입니다.` };
    }

    return new Promise((resolve) => {
      const server = net.createServer((socket) => {
        session.conn.forwardOut(bindHost, localPort, remoteHost, remotePort, (err, stream) => {
          if (err) {
            socket.end();
            return;
          }
          const fwd = portForwards.get(forwardId);
          if (fwd) fwd.connectionCount = (fwd.connectionCount || 0) + 1;
          notifyPortForwardUpdate(sessionId);
          socket.pipe(stream).pipe(socket);
          stream.on('close', () => {
            if (fwd) fwd.connectionCount = Math.max(0, (fwd.connectionCount || 0) - 1);
            notifyPortForwardUpdate(sessionId);
          });
        });
      });

      server.on('error', (err) => {
        resolve({ success: false, error: err.message });
      });

      server.listen(localPort, bindHost, () => {
        portForwards.set(forwardId, {
          type: 'local', server, sessionId,
          localHost: bindHost, localPort,
          remoteHost, remotePort,
          connectionCount: 0
        });
        notifyPortForwardUpdate(sessionId);
        resolve({ success: true, forwardId });
      });
    });
  });

  // Remote port forwarding (-R): remoteHost:remotePort -> localHost:localPort
  ipcMain.handle('port-forward-remote', async (event, { sessionId, remotePort, localHost, localPort, remoteHost }) => {
    const session = sshConnections.get(sessionId);
    if (!session || !session.conn) {
      return { success: false, error: 'SSH 연결이 없습니다.' };
    }

    const bindHost = remoteHost || '0.0.0.0';
    const forwardId = `remote-${sessionId}-${remotePort}`;

    if (portForwards.has(forwardId)) {
      return { success: false, error: `원격 포트 ${remotePort}이(가) 이미 포워딩 중입니다.` };
    }

    return new Promise((resolve) => {
      session.conn.forwardIn(bindHost, remotePort, (err) => {
        if (err) return resolve({ success: false, error: err.message });

        portForwards.set(forwardId, {
          type: 'remote', sessionId,
          localHost: localHost || '127.0.0.1', localPort,
          remoteHost: bindHost, remotePort,
          connectionCount: 0
        });
        notifyPortForwardUpdate(sessionId);
        resolve({ success: true, forwardId });
      });
    });
  });

  // Handle incoming remote forward connections
  // This needs to be set up per-connection. We'll add a listener when connection is established.
  function setupRemoteForwardHandler(sessionId, conn) {
    conn.on('tcp connection', (info, accept, reject) => {
      // Find matching remote forward
      let matched = null;
      for (const [id, fwd] of portForwards.entries()) {
        if (fwd.sessionId === sessionId && fwd.type === 'remote' && fwd.remotePort === info.destPort) {
          matched = { id, fwd };
          break;
        }
      }

      if (!matched) {
        reject();
        return;
      }

      const stream = accept();
      const socket = net.connect(matched.fwd.localPort, matched.fwd.localHost || '127.0.0.1', () => {
        matched.fwd.connectionCount = (matched.fwd.connectionCount || 0) + 1;
        notifyPortForwardUpdate(sessionId);
        stream.pipe(socket).pipe(stream);
      });

      socket.on('error', () => { try { stream.end(); } catch(e) {} });
      stream.on('error', () => { try { socket.end(); } catch(e) {} });
      socket.on('close', () => {
        matched.fwd.connectionCount = Math.max(0, (matched.fwd.connectionCount || 0) - 1);
        notifyPortForwardUpdate(sessionId);
      });
    });
  }

  // Dynamic port forwarding (-D SOCKS5 proxy)
  ipcMain.handle('port-forward-dynamic', async (event, { sessionId, localPort, localHost }) => {
    const session = sshConnections.get(sessionId);
    if (!session || !session.conn) {
      return { success: false, error: 'SSH 연결이 없습니다.' };
    }

    const bindHost = localHost || '127.0.0.1';
    const forwardId = `dynamic-${sessionId}-${localPort}`;

    if (portForwards.has(forwardId)) {
      return { success: false, error: `포트 ${localPort}이(가) 이미 사용 중입니다.` };
    }

    return new Promise((resolve) => {
      const server = net.createServer((socket) => {
        // SOCKS5 handshake
        socket.once('data', (data) => {
          if (data[0] !== 0x05) { socket.end(); return; }

          // No auth required
          socket.write(Buffer.from([0x05, 0x00]));

          socket.once('data', (reqData) => {
            if (reqData[1] !== 0x01) { // Only CONNECT supported
              socket.write(Buffer.from([0x05, 0x07, 0x00, 0x01, 0,0,0,0, 0,0]));
              socket.end();
              return;
            }

            let dstHost, dstPort;
            const addrType = reqData[3];

            try {
              if (addrType === 0x01) { // IPv4
                dstHost = `${reqData[4]}.${reqData[5]}.${reqData[6]}.${reqData[7]}`;
                dstPort = reqData.readUInt16BE(8);
              } else if (addrType === 0x03) { // Domain name
                const domainLen = reqData[4];
                dstHost = reqData.slice(5, 5 + domainLen).toString();
                dstPort = reqData.readUInt16BE(5 + domainLen);
              } else if (addrType === 0x04) { // IPv6
                dstHost = '::1'; // Simplified
                dstPort = reqData.readUInt16BE(20);
              } else {
                socket.end();
                return;
              }
            } catch (e) {
              socket.end();
              return;
            }

            session.conn.forwardOut(bindHost, 0, dstHost, dstPort, (err, stream) => {
              if (err) {
                socket.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0,0,0,0, 0,0]));
                socket.end();
                return;
              }

              // Success reply
              socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0,0,0,0, 0,0]));
              const fwd = portForwards.get(forwardId);
              if (fwd) fwd.connectionCount = (fwd.connectionCount || 0) + 1;
              notifyPortForwardUpdate(sessionId);

              socket.pipe(stream).pipe(socket);
              stream.on('close', () => {
                if (fwd) fwd.connectionCount = Math.max(0, (fwd.connectionCount || 0) - 1);
                notifyPortForwardUpdate(sessionId);
              });
              stream.on('error', () => { try { socket.end(); } catch(e) {} });
            });
          });
        });

        socket.on('error', () => {});
      });

      server.on('error', (err) => {
        resolve({ success: false, error: err.message });
      });

      server.listen(localPort, bindHost, () => {
        portForwards.set(forwardId, {
          type: 'dynamic', server, sessionId,
          localHost: bindHost, localPort,
          remoteHost: '*', remotePort: 0,
          connectionCount: 0
        });
        notifyPortForwardUpdate(sessionId);
        resolve({ success: true, forwardId });
      });
    });
  });

  // Stop a port forward
  ipcMain.handle('port-forward-stop', async (event, { forwardId }) => {
    const forward = portForwards.get(forwardId);
    if (!forward) {
      return { success: false, error: '포트 포워딩을 찾을 수 없습니다.' };
    }

    try {
      if (forward.type === 'local' || forward.type === 'dynamic') {
        if (forward.server) forward.server.close();
      } else if (forward.type === 'remote') {
        const session = sshConnections.get(forward.sessionId);
        if (session && session.conn) {
          session.conn.unforwardIn(forward.remoteHost || '0.0.0.0', forward.remotePort);
        }
      }
    } catch (e) {}

    const sessionId = forward.sessionId;
    portForwards.delete(forwardId);
    notifyPortForwardUpdate(sessionId);
    return { success: true };
  });

  // List port forwards for a session
  ipcMain.handle('port-forward-list', async (event, { sessionId }) => {
    const forwards = [];
    for (const [id, fwd] of portForwards.entries()) {
      if (fwd.sessionId === sessionId) {
        forwards.push({
          id,
          type: fwd.type,
          localHost: fwd.localHost,
          localPort: fwd.localPort,
          remoteHost: fwd.remoteHost,
          remotePort: fwd.remotePort,
          connectionCount: fwd.connectionCount || 0
        });
      }
    }
    return forwards;
  });

  // Notify renderer of port forward changes
  function notifyPortForwardUpdate(sessionId) {
    const forwards = [];
    for (const [id, fwd] of portForwards.entries()) {
      if (fwd.sessionId === sessionId) {
        forwards.push({
          id,
          type: fwd.type,
          localHost: fwd.localHost,
          localPort: fwd.localPort,
          remoteHost: fwd.remoteHost,
          remotePort: fwd.remotePort,
          connectionCount: fwd.connectionCount || 0
        });
      }
    }
    const targetWindow = getWindowForSession(sessionId);
    if (targetWindow) {
      targetWindow.webContents.send('port-forward-update', { sessionId, forwards });
    }
  }

  // Clean up port forwards for a session (called on disconnect)
  function cleanupPortForwards(sessionId) {
    for (const [id, fwd] of portForwards.entries()) {
      if (fwd.sessionId === sessionId) {
        try {
          if (fwd.type === 'local' || fwd.type === 'dynamic') {
            if (fwd.server) fwd.server.close();
          }
        } catch (e) {}
        portForwards.delete(id);
      }
    }
  }

  return { setupRemoteForwardHandler, cleanupPortForwards };
}

module.exports = { registerPortForwardIpc };
