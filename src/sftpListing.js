// Reads a remote folder part by part and reports how many entries have arrived so far, so a folder
// with thousands of files can show "불러오는 중… N개" instead of looking stuck.

/** SFTP status code a server answers with when a folder has no more entries */
const STATUS_EOF = 1;
const DEFAULT_REPORT_EVERY = 500;

const call = (sftp, method, ...args) => new Promise((resolve, reject) => {
  sftp[method](...args, (err, value) => (err ? reject(err) : resolve(value)));
});

/**
 * @param {object} sftp ssh2 SFTP session
 * @param {string} remotePath
 * @param {(count: number) => void} [onProgress] called as entries arrive (not for small folders)
 * @param {number} [reportEvery] entries between two reports
 * @returns {Promise<Array<object>>} the entries, as ssh2's readdir(path) gives them
 */
async function readDirectory(sftp, remotePath, onProgress, reportEvery = DEFAULT_REPORT_EVERY) {
  const handle = await call(sftp, 'opendir', remotePath);
  const entries = [];
  let reported = 0;
  try {
    for (;;) {
      let part;
      try {
        part = await call(sftp, 'readdir', handle);
      } catch (err) {
        if (err && err.code === STATUS_EOF) break;
        throw err;
      }
      // Some servers answer an empty list instead of the end code
      if (!part || part.length === 0) break;
      for (const entry of part) entries.push(entry);
      if (onProgress && entries.length - reported >= reportEvery) {
        reported = entries.length;
        onProgress(entries.length);
      }
    }
  } finally {
    // The listing is what matters: a failed close must not turn it into an error
    await call(sftp, 'close', handle).catch(() => {});
  }
  return entries;
}

module.exports = { readDirectory };
