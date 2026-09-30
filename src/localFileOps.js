// Local file operations for the SFTP panel's local pane (rename, new folder, trash).
const fs = require('fs');
const path = require('path');

const ERROR_MESSAGES = {
  EEXIST: '같은 이름의 항목이 이미 있습니다.',
  ENOENT: '대상을 찾을 수 없습니다.',
  EPERM: '권한이 없거나 다른 프로그램이 사용 중입니다.',
  EACCES: '권한이 없습니다.',
  EBUSY: '다른 프로그램이 사용 중입니다.',
  ENOTEMPTY: '폴더가 비어 있지 않습니다.'
};

const describe = (err) => ERROR_MESSAGES[err.code] || err.message;

const samePath = (a, b) => (process.platform === 'win32'
  ? path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase()
  : path.normalize(a) === path.normalize(b));

const isDriveOrFsRoot = (p) => samePath(path.parse(p).root, p);

/** Two paths name the same entry (e.g. a case-only rename on a case-insensitive disk) */
async function isSameEntry(a, b) {
  try {
    const [sa, sb] = await Promise.all([fs.promises.lstat(a, { bigint: true }), fs.promises.lstat(b, { bigint: true })]);
    return sa.ino === sb.ino && sa.dev === sb.dev;
  } catch (e) {
    return false;
  }
}

/**
 * Rename within one folder. Refuses to overwrite: fs.rename silently replaces files on Windows.
 */
async function renameLocal(oldPath, newPath) {
  if (!path.isAbsolute(oldPath) || !path.isAbsolute(newPath)) {
    return { success: false, error: '잘못된 경로입니다.' };
  }
  if (!samePath(path.dirname(oldPath), path.dirname(newPath))) {
    return { success: false, error: '같은 폴더 안에서만 이름을 바꿀 수 있습니다.' };
  }
  try {
    await fs.promises.lstat(oldPath);
    const targetExists = await fs.promises.lstat(newPath).then(() => true, () => false);
    if (targetExists && !(await isSameEntry(oldPath, newPath))) {
      return { success: false, error: ERROR_MESSAGES.EEXIST };
    }
    await fs.promises.rename(oldPath, newPath);
    return { success: true };
  } catch (err) {
    return { success: false, error: describe(err) };
  }
}

async function mkdirLocal(dirPath) {
  if (!path.isAbsolute(dirPath)) return { success: false, error: '잘못된 경로입니다.' };
  try {
    await fs.promises.mkdir(dirPath);
    return { success: true };
  } catch (err) {
    return { success: false, error: describe(err) };
  }
}

/**
 * Move entries to the OS trash one by one. `trashItem` is Electron's shell.trashItem.
 * Drive roots and relative paths are never passed through.
 */
async function trashLocal(paths, trashItem) {
  const failures = [];
  let trashed = 0;
  for (const target of paths) {
    if (typeof target !== 'string' || !path.isAbsolute(target) || isDriveOrFsRoot(target)) {
      failures.push({ path: String(target), error: '잘못된 경로입니다.' });
      continue;
    }
    try {
      await trashItem(target);
      trashed++;
    } catch (err) {
      failures.push({ path: target, error: describe(err) });
    }
  }
  return { trashed, failures };
}

module.exports = { renameLocal, mkdirLocal, trashLocal };
