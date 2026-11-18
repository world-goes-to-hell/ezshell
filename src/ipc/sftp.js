// SFTP panel: the server side (list, download, upload, rename, delete over a tab's SSH connection),
// this PC's side (folders, drives, rename, move, trash) and the transfer queue of each session.
// Moved out of main.js as it was; main.js hands in what it shares (the connections, the windows).

const fs = require('fs');
const path = require('path');
const localPlaces = require('../localPlaces.js');
const localFileOps = require('../localFileOps.js');
const sftpSymlinks = require('../sftpSymlinks.js');
const sftpUploadCheck = require('../sftpUploadCheck.js');
const { readDirectory } = require('../sftpListing.js');
const { downloadDirectory } = require('../sftpDownloadDir.js');

function registerSftpIpc(ctx) {
  const { ipcMain, dialog, app, shell, sshConnections, sftpWindows } = ctx;

  // ==================== SFTP 기능 ====================

  // One panel channel per tab, including the time while the server is opening it.
  const sftpSessions = new Map();

  const sftpOf = (sessionId) => {
    const entry = sftpSessions.get(sessionId);
    return entry && entry.conn === sshConnections.get(sessionId)?.conn ? entry.channel : null;
  };

  function endChannel(sftp) {
    try { sftp?.end(); } catch { /* already closed */ }
  }

  function closeSftpSession(sessionId) {
    const entry = sftpSessions.get(sessionId);
    if (!entry) return;
    sftpSessions.delete(sessionId);
    entry.reject(new Error('SFTP 세션이 닫혔습니다.'));
    endChannel(entry.channel);
  }

  ipcMain.handle('sftp-open', async (event, { sessionId }) => {
    const conn = sshConnections.get(sessionId)?.conn;
    const existing = sftpSessions.get(sessionId);
    if (existing && existing.conn === conn) {
      await existing.ready;
      return { success: true, alreadyOpen: true };
    }
    closeSftpSession(sessionId);
    if (!conn) throw new Error('SSH 연결이 없습니다.');

    let resolveOpen, rejectOpen;
    const ready = new Promise((resolve, reject) => { resolveOpen = resolve; rejectOpen = reject; });
    const entry = { conn, ready, reject: rejectOpen, channel: null };
    sftpSessions.set(sessionId, entry);

    const forget = () => {
      if (sftpSessions.get(sessionId) === entry) sftpSessions.delete(sessionId);
    };
    const opened = (err, channel) => {
      if (err) {
        forget();
        rejectOpen(err);
        return;
      }
      // A close or reconnect that won the race must not leave an untracked channel on the server.
      if (sftpSessions.get(sessionId) !== entry || sshConnections.get(sessionId)?.conn !== conn) {
        forget();
        endChannel(channel);
        rejectOpen(new Error('SFTP 세션이 닫혔습니다.'));
        return;
      }
      entry.channel = channel;
      channel.once('close', forget);
      resolveOpen();
    };
    try { conn.sftp(opened); } catch (err) { opened(err); }
    await ready;
    return { success: true };
  });

  // SFTP 세션 닫기
  ipcMain.handle('sftp-close', async (event, { sessionId }) => {
    closeSftpSession(sessionId);
    return { success: true };
  });

  // 디렉토리 목록 조회
  // OpenSSH's sftp-server sends an `ls -l` style line per entry:
  // "drwxr-xr-x    2 root     root         4096 Jan  1 00:00 name" -> owner/group names.
  // Other servers may omit it, so callers fall back to the numeric uid/gid.
  const LONGNAME_MODE_PATTERN = /^[-dlcbpsD][-rwxsStT]{9}/;
  function parseLongnameOwner(longname) {
    if (typeof longname !== 'string') return null;
    const parts = longname.trim().split(/\s+/);
    if (parts.length < 4 || !LONGNAME_MODE_PATTERN.test(parts[0])) return null;
    return { owner: parts[2], group: parts[3] };
  }

  ipcMain.handle('sftp-list', async (event, { sessionId, remotePath }) => {
    const sftp = sftpOf(sessionId);
    if (!sftp) {
      throw new Error('SFTP 세션이 없습니다.');
    }

    // Read in parts, telling the window how many entries have arrived (a big folder takes a while)
    const reportProgress = (count) => {
      if (!event.sender.isDestroyed()) event.sender.send('sftp-list-progress', { sessionId, remotePath, count });
    };
    const listing = await readDirectory(sftp, remotePath, reportProgress).then((list) => {
      {
        const files = list.map(item => {
          const names = parseLongnameOwner(item.longname);
          return {
          name: item.filename,
          size: item.attrs.size,
          // readdir attrs describe the link itself: a link to a directory has isDirectory false.
          // Link details are added below without changing isDirectory, which delete/rename rely on.
          isDirectory: item.attrs.isDirectory(),
          isFile: item.attrs.isFile(),
          isSymlink: item.attrs.isSymbolicLink(),
          mode: item.attrs.mode,
          mtime: item.attrs.mtime * 1000,
          permissions: (item.attrs.mode & 0o777).toString(8).padStart(3, '0'),
          owner: names ? names.owner : String(item.attrs.uid),
          group: names ? names.group : String(item.attrs.gid)
          };
        }).sort((a, b) => {
          // 디렉토리 먼저, 그 다음 이름순
          if (a.isDirectory && !b.isDirectory) return -1;
          if (!a.isDirectory && b.isDirectory) return 1;
          return a.name.localeCompare(b.name);
        });

        return files;
      }
    }, (err) => {
      // Permission denied 에러를 더 명확하게 전달
      if (err.code === 2 || String(err.message).includes('Permission denied')) {
        throw new Error('Permission denied: 이 폴더에 접근할 권한이 없습니다.');
      }
      throw new Error(err.message || '폴더를 읽을 수 없습니다.');
    });

    return sftpSymlinks.resolveSymlinks(remotePath, listing, {
      stat: (p) => new Promise((resolve, reject) => sftp.stat(p, (err, stats) => (err ? reject(err) : resolve(stats)))),
      readlink: (p) => new Promise((resolve, reject) => sftp.readlink(p, (err, target) => (err ? reject(err) : resolve(target))))
    });
  });

  // 파일 다운로드
  ipcMain.handle('sftp-download', async (event, { sessionId, remotePath, localPath }) => {
    const sftp = sftpOf(sessionId);
    if (!sftp) {
      throw new Error('SFTP 세션이 없습니다.');
    }

    return new Promise((resolve, reject) => {
      // 파일 크기 확인
      sftp.stat(remotePath, (err, stats) => {
        if (err) {
          reject(err);
          return;
        }

        const totalSize = stats.size;
        let downloadedSize = 0;

        const readStream = sftp.createReadStream(remotePath);
        const writeStream = fs.createWriteStream(localPath);

        readStream.on('data', (chunk) => {
          downloadedSize += chunk.length;
          const progress = Math.round((downloadedSize / totalSize) * 100);
          ctx.mainWindow.webContents.send('sftp-progress', {
            sessionId,
            type: 'download',
            fileName: path.basename(remotePath),
            progress,
            loaded: downloadedSize,
            total: totalSize
          });
        });

        readStream.on('error', reject);
        writeStream.on('error', reject);

        writeStream.on('finish', () => {
          resolve({ success: true, localPath });
        });

        readStream.pipe(writeStream);
      });
    });
  });

  // 파일 업로드
  ipcMain.handle('sftp-upload', async (event, { sessionId, localPath, remotePath }) => {
    const sftp = sftpOf(sessionId);
    if (!sftp) {
      throw new Error('SFTP 세션이 없습니다.');
    }

    return new Promise((resolve, reject) => {
      const stats = fs.statSync(localPath);
      const totalSize = stats.size;
      let uploadedSize = 0;

      const readStream = fs.createReadStream(localPath);
      const writeStream = sftp.createWriteStream(remotePath);

      readStream.on('data', (chunk) => {
        uploadedSize += chunk.length;
        const progress = Math.round((uploadedSize / totalSize) * 100);
        ctx.mainWindow.webContents.send('sftp-progress', {
          sessionId,
          type: 'upload',
          fileName: path.basename(localPath),
          progress,
          loaded: uploadedSize,
          total: totalSize
        });
      });

      readStream.on('error', reject);
      writeStream.on('error', reject);

      writeStream.on('close', () => {
        resolve({ success: true, remotePath });
      });

      readStream.pipe(writeStream);
    });
  });

  // 파일/폴더 삭제
  ipcMain.handle('sftp-delete', async (event, { sessionId, remotePath, isDirectory }) => {
    const sftp = sftpOf(sessionId);
    if (!sftp) {
      throw new Error('SFTP 세션이 없습니다.');
    }

    return new Promise((resolve, reject) => {
      if (isDirectory) {
        sftp.rmdir(remotePath, (err) => {
          if (err) reject(err);
          else resolve({ success: true });
        });
      } else {
        sftp.unlink(remotePath, (err) => {
          if (err) reject(err);
          else resolve({ success: true });
        });
      }
    });
  });

  // 이름 변경
  // What a path is (links followed), for a name right-clicked in the terminal. Null when it is not there.
  ipcMain.handle('sftp-stat', (event, { sessionId, remotePath }) => {
    const sftp = sftpOf(sessionId);
    if (!sftp) throw new Error('SFTP 세션이 없습니다.');
    return new Promise((resolve) => {
      sftp.stat(String(remotePath), (err, stats) => {
        if (err || !stats) return resolve(null);
        resolve({ isFile: stats.isFile(), isDirectory: stats.isDirectory(), size: stats.size });
      });
    });
  });

  // The server's own spelling of a path ('.' is the login folder), for "SFTP 를 현재 폴더로"
  ipcMain.handle('sftp-realpath', (event, { sessionId, remotePath }) => {
    const sftp = sftpOf(sessionId);
    if (!sftp) throw new Error('SFTP 세션이 없습니다.');
    return new Promise((resolve, reject) => {
      sftp.realpath(String(remotePath), (err, resolved) => (err ? reject(err) : resolve(resolved)));
    });
  });

  ipcMain.handle('sftp-rename', async (event, { sessionId, oldPath, newPath }) => {
    const sftp = sftpOf(sessionId);
    if (!sftp) {
      throw new Error('SFTP 세션이 없습니다.');
    }

    return new Promise((resolve, reject) => {
      sftp.rename(oldPath, newPath, (err) => {
        if (err) reject(err);
        else resolve({ success: true });
      });
    });
  });

  // 폴더 생성
  ipcMain.handle('sftp-mkdir', async (event, { sessionId, remotePath }) => {
    const sftp = sftpOf(sessionId);
    if (!sftp) {
      throw new Error('SFTP 세션이 없습니다.');
    }

    return new Promise((resolve, reject) => {
      sftp.mkdir(remotePath, (err) => {
        if (err) reject(err);
        else resolve({ success: true });
      });
    });
  });

  // 다운로드 경로 선택 다이얼로그
  ipcMain.handle('select-download-path', async (event, { defaultName }) => {
    const result = await dialog.showSaveDialog(ctx.mainWindow, {
      title: '다운로드 위치 선택',
      defaultPath: defaultName,
      properties: ['createDirectory']
    });

    if (result.canceled) {
      return { success: false };
    }
    return { success: true, path: result.filePath };
  });

  // 업로드 파일 선택 다이얼로그
  ipcMain.handle('select-upload-files', async () => {
    const result = await dialog.showOpenDialog(ctx.mainWindow, {
      title: '업로드할 파일 선택',
      properties: ['openFile', 'multiSelections']
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { success: false };
    }
    return { success: true, paths: result.filePaths };
  });

  // ==================== 로컬 파일 시스템 ====================

  // 로컬 디렉토리 목록 조회
  // The SFTP panel's local path bar: the usual folders and the drives of this PC (src/localPlaces.js).
  // Takes nothing from the window; only fixed places come back.
  const localPlacesReader = localPlaces.createPlacesReader({
    platform: process.platform,
    getPath: (name) => app.getPath(name),
    isDirectory: (p) => fs.promises.stat(p).then(stat => stat.isDirectory(), () => false),
    runPowerShell: localPlaces.powerShellRunner({ execFile: require('child_process').execFile }),
    readDir: (dir) => fs.promises.readdir(dir),
    username: require('os').userInfo().username
  });
  ipcMain.handle('local-places', () => localPlacesReader.read());


  ipcMain.handle('local-list', async (event, { dirPath }) => {
    try {
      const dirents = await fs.promises.readdir(dirPath, { withFileTypes: true });

      const statResults = await Promise.allSettled(
        dirents.map(async (dirent) => {
          const fullPath = path.join(dirPath, dirent.name);
          try {
            const stats = await fs.promises.stat(fullPath);
            return {
              name: dirent.name,
              size: stats.size,
              isDirectory: dirent.isDirectory(),
              isFile: dirent.isFile(),
              mtime: stats.mtime.getTime(),
              path: fullPath
            };
          } catch (e) {
            return null;
          }
        })
      );

      const fileList = statResults
        .filter(r => r.status === 'fulfilled' && r.value !== null)
        .map(r => r.value)
        .sort((a, b) => {
          if (a.isDirectory && !b.isDirectory) return -1;
          if (!a.isDirectory && b.isDirectory) return 1;
          return a.name.localeCompare(b.name);
        });

      return { success: true, files: fileList };
    } catch (err) {
      throw err;
    }
  });

  // 로컬 이름 변경 / 폴더 생성 / 휴지통 이동 (SFTP 패널 로컬 목록)
  ipcMain.handle('local-rename', (event, { oldPath, newPath }) => localFileOps.renameLocal(oldPath, newPath));
  ipcMain.handle('local-mkdir', (event, { dirPath }) => localFileOps.mkdirLocal(dirPath));
  ipcMain.handle('local-move', (event, { sourcePath, targetDir }) => localFileOps.moveLocal(sourcePath, targetDir));
  ipcMain.handle('local-trash', (event, { paths }) =>
    localFileOps.trashLocal(Array.isArray(paths) ? paths : [], (target) => shell.trashItem(target)));

  // 로컬 폴더 선택 다이얼로그
  ipcMain.handle('select-local-folder', async () => {
    const result = await dialog.showOpenDialog(ctx.mainWindow, {
      title: '로컬 폴더 선택',
      properties: ['openDirectory']
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { success: false };
    }
    return { success: true, path: result.filePaths[0] };
  });

  // ==================== Transfer Queue ====================

  class TransferQueue {
    constructor(sessionId) {
      this.sessionId = sessionId;
      this.queue = []; // { id, type, localPath, remotePath, status, progress, size, speed, startTime }
      this.activeTransfers = new Map();
      this.maxConcurrent = 2;
      this.abortControllers = new Map();
    }

    add(transfer) {
      transfer.id = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      transfer.status = 'queued';
      transfer.progress = 0;
      transfer.speed = 0;
      transfer.startTime = null;
      this.queue.push(transfer);
      this.emitQueueUpdate();
      this.processQueue();
      return transfer.id;
    }

    pause(id) {
      const transfer = this.queue.find(t => t.id === id);
      if (transfer && transfer.status === 'active') {
        transfer.status = 'paused';
        const controller = this.abortControllers.get(id);
        if (controller) {
          controller.abort();
          this.abortControllers.delete(id);
        }
        this.activeTransfers.delete(id);
        this.emitQueueUpdate();
      }
    }

    resume(id) {
      const transfer = this.queue.find(t => t.id === id);
      if (transfer && transfer.status === 'paused') {
        transfer.status = 'queued';
        this.emitQueueUpdate();
        this.processQueue();
      }
    }

    async retry(id, overwrite) {
      const transfer = this.queue.find(t => t.id === id && t.status === 'error');
      if (!transfer) return { success: false };
      const failedAt = transfer.startTime;

      const sftp = sftpOf(this.sessionId);
      if (!sftp) return { success: false, error: 'SFTP 연결이 끊겼습니다. 연결한 뒤 다시 시도하세요.' };
      const isDownload = transfer.type === 'download';
      const targetPath = isDownload ? transfer.localPath : transfer.remotePath;
      try {
        const stats = isDownload
          ? await fs.promises.lstat(targetPath)
          : await new Promise((resolve, reject) => sftp.stat(targetPath, (error, result) => error ? reject(error) : resolve(result)));
        if (stats.isDirectory()) return { success: false, error: '대상 경로에 같은 이름의 폴더가 있습니다.' };
        if (!overwrite) return { success: false, needsOverwrite: true };
      } catch (error) {
        if (error.code !== (isDownload ? 'ENOENT' : 2)) return { success: false, error: error.message };
      }

      // Another window may have already retried or dismissed the error while the target was checked.
      if (transfer.status !== 'error' || transfer.startTime !== failedAt || !this.queue.includes(transfer)) return { success: false };
      Object.assign(transfer, { status: 'queued', progress: 0, speed: 0, size: undefined, error: undefined, startTime: null });
      this.emitQueueUpdate();
      this.processQueue();
      return { success: true };
    }

    cancel(id, failedOnly) {
      const transfer = this.queue.find(t => t.id === id);
      if (failedOnly && transfer?.status !== 'error') return;
      if (transfer) {
        const controller = this.abortControllers.get(id);
        if (controller) {
          controller.abort();
          this.abortControllers.delete(id);
        }
        this.activeTransfers.delete(id);
        this.queue = this.queue.filter(t => t.id !== id);
        this.emitQueueUpdate();
        this.processQueue();
      }
    }

    clearCompleted() {
      this.queue = this.queue.filter(t => t.status !== 'completed');
      this.emitQueueUpdate();
    }

    processQueue() {
      const activeCount = this.activeTransfers.size;
      const availableSlots = this.maxConcurrent - activeCount;

      if (availableSlots <= 0) return;

      const queuedTransfers = this.queue.filter(t => t.status === 'queued');
      const toStart = queuedTransfers.slice(0, availableSlots);

      for (const transfer of toStart) {
        this.startTransfer(transfer);
      }
    }

    async startTransfer(transfer) {
      transfer.status = 'active';
      transfer.startTime = Date.now();
      this.activeTransfers.set(transfer.id, transfer);
      this.emitQueueUpdate();

      const abortController = { aborted: false, abort: function() { this.aborted = true; } };
      this.abortControllers.set(transfer.id, abortController);

      try {
        if (transfer.type === 'download') {
          await this.executeDownload(transfer, abortController);
        } else {
          await this.executeUpload(transfer, abortController);
        }

        if (!abortController.aborted) {
          transfer.status = 'completed';
          transfer.progress = 100;
          transfer.completedAt = Date.now();
        }
      } catch (err) {
        if (!abortController.aborted) {
          transfer.status = 'error';
          transfer.error = err.message;
        }
      }

      this.activeTransfers.delete(transfer.id);
      this.abortControllers.delete(transfer.id);
      this.emitQueueUpdate();
      this.processQueue();
    }

    async executeDownload(transfer, abortController) {
      const session = sshConnections.get(this.sessionId);
      if (!session || !session.conn) throw new Error('No SSH connection');

      const sftp = sftpOf(this.sessionId);
      if (!sftp) throw new Error('No SFTP connection');

      const CHUNK_SIZE = 64 * 1024; // 64KB

      return new Promise((resolve, reject) => {
        sftp.stat(transfer.remotePath, (err, stats) => {
          if (err) return reject(err);

          transfer.size = stats.size;
          // localPath is already the full target file path (callers pass dir + name, and the
          // "rename" overwrite option passes a new name). Joining the remote basename again
          // produced "<file>\<file>" and every download failed with ENOENT.
          const writeStream = fs.createWriteStream(transfer.localPath);
          const readStream = sftp.createReadStream(transfer.remotePath, { highWaterMark: CHUNK_SIZE });

          let downloaded = 0;
          let lastTime = Date.now();
          let lastBytes = 0;

          readStream.on('data', (chunk) => {
            if (abortController.aborted) {
              readStream.destroy();
              writeStream.destroy();
              return;
            }

            downloaded += chunk.length;
            transfer.progress = Math.round((downloaded / transfer.size) * 100);

            // Calculate speed
            const now = Date.now();
            const elapsed = (now - lastTime) / 1000;
            if (elapsed >= 0.5) { // Update speed every 500ms
              transfer.speed = Math.round((downloaded - lastBytes) / elapsed);
              lastTime = now;
              lastBytes = downloaded;
              this.emitProgress(transfer);
            }
          });

          writeStream.on('finish', resolve);

          readStream.on('error', (err) => {
            writeStream.destroy();
            reject(err);
          });
          writeStream.on('error', (err) => {
            readStream.destroy();
            reject(err);
          });

          readStream.pipe(writeStream);
        });
      });
    }

    async executeUpload(transfer, abortController) {
      const session = sshConnections.get(this.sessionId);
      if (!session || !session.conn) throw new Error('No SSH connection');

      const sftp = sftpOf(this.sessionId);
      if (!sftp) throw new Error('No SFTP connection');

      const CHUNK_SIZE = 64 * 1024;

      return new Promise((resolve, reject) => {
        fs.stat(transfer.localPath, (err, stats) => {
          if (err) {
            return reject(err);
          }

          transfer.size = stats.size;
          // Use remotePath directly - it's already the full target path
          const remotePath = transfer.remotePath;

          const readStream = fs.createReadStream(transfer.localPath, { highWaterMark: CHUNK_SIZE });
          const writeStream = sftp.createWriteStream(remotePath);

          let uploaded = 0;
          let lastTime = Date.now();
          let lastBytes = 0;

          readStream.on('data', (chunk) => {
            if (abortController.aborted) {
              readStream.destroy();
              writeStream.destroy();
              return;
            }

            uploaded += chunk.length;
            transfer.progress = Math.round((uploaded / transfer.size) * 100);

            const now = Date.now();
            const elapsed = (now - lastTime) / 1000;
            if (elapsed >= 0.5) {
              transfer.speed = Math.round((uploaded - lastBytes) / elapsed);
              lastTime = now;
              lastBytes = uploaded;
              this.emitProgress(transfer);
            }

            // Manually write chunk with backpressure handling
            if (!writeStream.write(chunk)) {
              readStream.pause();
              writeStream.once('drain', () => readStream.resume());
            }
          });

          readStream.on('end', () => {
            writeStream.end();
          });

          // 'close' also follows a WRITE the server rejected (no 'error' from ssh2), so check the result
          writeStream.on('close', () => {
            readStream.destroy();
            if (abortController.aborted) return resolve();
            const stat = (p) => new Promise((ok, fail) => sftp.stat(p, (statErr, s) => (statErr ? fail(statErr) : ok(s))));
            sftpUploadCheck.verifyUploadedSize(stat, remotePath, transfer.size).then(resolve, reject);
          });

          readStream.on('error', (err) => {
            writeStream.destroy();
            reject(err);
          });
          writeStream.on('error', (err) => {
            readStream.destroy();
            reject(err);
          });
        });
      });
    }

    /** Queue as the renderer sees it (queue updates and sftp-get-queue use the same shape) */
    snapshot() {
      return this.queue.map(t => ({
        id: t.id,
        type: t.type,
        fileName: path.basename(t.type === 'download' ? t.remotePath : t.localPath),
        // Full source/target paths: the file lists mark the names each transfer landed on
        localPath: t.localPath,
        remotePath: t.remotePath,
        status: t.status,
        progress: t.progress,
        completedAt: t.completedAt,
        size: t.size,
        speed: t.speed,
        error: t.error
      }));
    }

    emitQueueUpdate() {
      sendToSftpViews(this.sessionId, 'sftp-queue-update', {
        sessionId: this.sessionId,
        queue: this.snapshot()
      });
    }

    emitProgress(transfer) {
      sendToSftpViews(this.sessionId, 'sftp-transfer-progress', {
        sessionId: this.sessionId,
        transferId: transfer.id,
        progress: transfer.progress,
        speed: transfer.speed,
        size: transfer.size
      });
    }
  }

  // The SFTP panel lives in the main window, and a session may also have its own SFTP window
  function sendToSftpViews(sessionId, channel, payload) {
    const targets = [ctx.mainWindow, sftpWindows.get(sessionId)];
    for (const win of targets) {
      if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
    }
  }

  const transferQueues = new Map(); // sessionId -> TransferQueue

  function getTransferQueue(sessionId) {
    if (!transferQueues.has(sessionId)) {
      transferQueues.set(sessionId, new TransferQueue(sessionId));
    }
    return transferQueues.get(sessionId);
  }

  // Transfer Queue IPC Handlers
  ipcMain.handle('sftp-queue-download', (event, { sessionId, remotePath, localPath }) => {
    const queue = getTransferQueue(sessionId);
    const id = queue.add({ type: 'download', remotePath, localPath });
    return { success: true, transferId: id };
  });

  ipcMain.handle('sftp-queue-upload', (event, { sessionId, localPath, remotePath }) => {
    const queue = getTransferQueue(sessionId);
    const id = queue.add({ type: 'upload', localPath, remotePath });
    return { success: true, transferId: id };
  });

  // Recursive folder download (src/sftpDownloadDir.js): the same folders on this PC, every file through the
  // transfer queue. Links are not followed and names this PC cannot take are left out; the answer lists them.
  ipcMain.handle('sftp-download-directory', async (event, { sessionId, remoteDir, localDir }) => {
    const sftp = sftpOf(sessionId);
    if (!sftp) {
      throw new Error('SFTP 세션이 없습니다.');
    }
    if (typeof remoteDir !== 'string' || typeof localDir !== 'string' || !path.isAbsolute(localDir)) {
      throw new Error('폴더 경로가 올바르지 않습니다.');
    }
    const queue = getTransferQueue(sessionId);
    const result = await downloadDirectory({
      platform: process.platform,
      readdir: (dir) => new Promise((resolve, reject) => sftp.readdir(dir, (err, list) => (err ? reject(err) : resolve(list)))),
      mkdir: (dir) => fs.promises.mkdir(dir, { recursive: true }),
      queueDownload: ({ remotePath, localPath }) => queue.add({ type: 'download', remotePath, localPath })
    }, remoteDir, localDir);
    return { success: true, ...result };
  });

  // Recursive folder upload
  ipcMain.handle('sftp-upload-directory', async (event, { sessionId, localDir, remoteDir }) => {
    const sftp = sftpOf(sessionId);
    if (!sftp) {
      throw new Error('SFTP 세션이 없습니다.');
    }

    const uploadedFiles = [];

    const mkdirRecursive = (dirPath) => {
      return new Promise((resolve, reject) => {
        sftp.stat(dirPath, (err) => {
          if (!err) return resolve(); // Already exists
          sftp.mkdir(dirPath, (mkErr) => {
            if (mkErr && mkErr.code !== 4) reject(mkErr); // code 4 = already exists
            else resolve();
          });
        });
      });
    };

    const uploadRecursive = async (localPath, remotePath) => {
      const stats = fs.statSync(localPath);
      if (stats.isDirectory()) {
        await mkdirRecursive(remotePath);
        const entries = fs.readdirSync(localPath);
        for (const entry of entries) {
          const localEntryPath = path.join(localPath, entry);
          const remoteEntryPath = remotePath + '/' + entry;
          await uploadRecursive(localEntryPath, remoteEntryPath);
        }
      } else {
        // Queue individual file upload
        const queue = getTransferQueue(sessionId);
        queue.add({ type: 'upload', localPath, remotePath });
        uploadedFiles.push(remotePath);
      }
    };

    await uploadRecursive(localDir, remoteDir);
    return { success: true, uploadedFiles };
  });

  ipcMain.handle('sftp-transfer-pause', (event, { sessionId, transferId }) => {
    const queue = getTransferQueue(sessionId);
    queue.pause(transferId);
    return { success: true };
  });

  ipcMain.handle('sftp-transfer-resume', (event, { sessionId, transferId }) => {
    const queue = getTransferQueue(sessionId);
    queue.resume(transferId);
    return { success: true };
  });

  ipcMain.handle('sftp-transfer-retry', (event, { sessionId, transferId, overwrite }) => {
    return getTransferQueue(sessionId).retry(transferId, overwrite === true);
  });

  ipcMain.handle('sftp-transfer-cancel', (event, { sessionId, transferId, failedOnly }) => {
    const queue = getTransferQueue(sessionId);
    queue.cancel(transferId, failedOnly === true);
    return { success: true };
  });

  ipcMain.handle('sftp-queue-clear-completed', (event, { sessionId }) => {
    const queue = getTransferQueue(sessionId);
    queue.clearCompleted();
    return { success: true };
  });

  ipcMain.handle('sftp-get-queue', (event, { sessionId }) => {
    const queue = getTransferQueue(sessionId);
    return { queue: queue.snapshot() };
  });

  // Transfers waiting or running, in every tab (an update would cut them off)
  const activeTransferCount = () => {
    let count = 0;
    for (const queue of transferQueues.values()) {
      count += queue.queue.filter(t => t.status === 'queued' || t.status === 'active' || t.status === 'paused').length;
    }
    return count;
  };

  return { closeSftpSession, activeTransferCount };
}

module.exports = { registerSftpIpc };
