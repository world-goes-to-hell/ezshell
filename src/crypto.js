const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const SALT_LENGTH = 64;
const PBKDF2_ITERATIONS = 100000;

/**
 * Derive encryption key from password using PBKDF2
 */
function deriveKey(password, salt) {
  return crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha512');
}

/**
 * Same key as deriveKey, computed on libuv's thread pool so the caller's thread is not blocked
 */
function deriveKeyAsync(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(password, salt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha512', (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

/**
 * Encrypt text using AES-256-GCM
 */
function encrypt(text, masterPassword) {
  const salt = crypto.randomBytes(SALT_LENGTH);
  return encryptWithKey(text, deriveKey(masterPassword, salt), salt);
}

/**
 * encrypt() without blocking: for frequent background saves in the Electron main process,
 * where a synchronous PBKDF2 would stall IPC and terminal I/O
 */
async function encryptAsync(text, masterPassword) {
  const salt = crypto.randomBytes(SALT_LENGTH);
  return encryptWithKey(text, await deriveKeyAsync(masterPassword, salt), salt);
}

function encryptWithKey(text, key, salt) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag();

  return {
    encrypted,
    iv: iv.toString('hex'),
    salt: salt.toString('hex'),
    tag: tag.toString('hex'),
    version: 1 // For future migration support
  };
}

/**
 * Decrypt text using AES-256-GCM
 */
function decrypt(encryptedData, masterPassword) {
  const salt = Buffer.from(encryptedData.salt, 'hex');
  const iv = Buffer.from(encryptedData.iv, 'hex');
  const tag = Buffer.from(encryptedData.tag, 'hex');
  const key = deriveKey(masterPassword, salt);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  let decrypted = decipher.update(encryptedData.encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

/**
 * Hash password for verification (not for encryption)
 */
function hashPassword(password) {
  const salt = crypto.randomBytes(32);
  const hash = crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, 64, 'sha512');
  return {
    hash: hash.toString('hex'),
    salt: salt.toString('hex')
  };
}

/**
 * Verify password against stored hash
 */
function verifyPassword(password, storedHash, storedSalt) {
  const salt = Buffer.from(storedSalt, 'hex');
  const hash = crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, 64, 'sha512');
  return hash.toString('hex') === storedHash;
}

module.exports = {
  encrypt,
  encryptAsync,
  decrypt,
  hashPassword,
  verifyPassword
};
