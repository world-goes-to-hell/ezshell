// ssh2's SFTP write stream does not emit 'error' when the server rejects a WRITE: it only emits
// 'close', which looks exactly like a finished upload. Reading the size back is the only reliable check.

/**
 * @param {(remotePath: string) => Promise<{ size: number }>} stat
 * @param {string} remotePath
 * @param {number} expectedSize  size of the local source file
 * @returns {Promise<void>} rejects with a user-facing message when the remote file is incomplete
 */
async function verifyUploadedSize(stat, remotePath, expectedSize) {
  let remote;
  try {
    remote = await stat(remotePath);
  } catch (err) {
    throw new Error(`업로드 확인 실패: ${err && err.message ? err.message : String(err)}`);
  }
  if (remote.size !== expectedSize) {
    throw new Error(`업로드가 끝나지 않았습니다: 원격 ${remote.size} / 로컬 ${expectedSize} 바이트`);
  }
}

module.exports = { verifyUploadedSize };
