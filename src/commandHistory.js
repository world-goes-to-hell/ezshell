// Pure helpers for per-connection terminal command history.
// Loaded by main.js at runtime (copied to out/main/src like crypto.js), so keep it CommonJS
// and free of Electron imports.

const MAX_ENTRIES = 500;
const MAX_COMMAND_LENGTH = 4096;
const MAX_KEY_LENGTH = 300;
// Saved-session UUIDs, or "quick:user@host:port" for unsaved quick connects. User and host names
// may contain any printable character, so only whitespace and control characters are refused.
const HISTORY_KEY_PATTERN = /^[^\s\x00-\x1f\x7f]+$/;
const RESERVED_KEYS = ['__proto__', 'constructor', 'prototype'];
// Any C0 control character or DEL: a recorded command is a single printable line
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

function isValidHistoryKey(key) {
  return typeof key === 'string' &&
    key.length > 0 &&
    key.length <= MAX_KEY_LENGTH &&
    HISTORY_KEY_PATTERN.test(key) &&
    !RESERVED_KEYS.includes(key);
}

/** Returns the command when it is a storable single line, otherwise null. */
function normalizeCommand(command) {
  if (typeof command !== 'string') return null;
  if (command.trim().length === 0) return null;
  if (command.length > MAX_COMMAND_LENGTH) return null;
  if (CONTROL_CHARS.test(command)) return null;
  return command;
}

/** New list with the command on top; an existing identical command moves up instead of repeating. */
function addCommand(entries, command, now, max = MAX_ENTRIES) {
  const rest = entries.filter((entry) => entry.command !== command);
  return [{ command, lastUsedAt: now }, ...rest].slice(0, max);
}

function removeCommand(entries, command) {
  return entries.filter((entry) => entry.command !== command);
}

function isValidEntry(entry) {
  return entry !== null &&
    typeof entry === 'object' &&
    normalizeCommand(entry.command) !== null &&
    typeof entry.lastUsedAt === 'number';
}

/** Drops anything malformed from data read back from disk. */
function sanitizeHistory(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw)
      .filter(([key]) => isValidHistoryKey(key))
      .map(([key, entries]) => [
        key,
        Array.isArray(entries)
          ? entries.filter(isValidEntry).map(({ command, lastUsedAt }) => ({ command, lastUsedAt })).slice(0, MAX_ENTRIES)
          : []
      ])
  );
}

module.exports = {
  MAX_ENTRIES,
  MAX_COMMAND_LENGTH,
  isValidHistoryKey,
  normalizeCommand,
  addCommand,
  removeCommand,
  sanitizeHistory
};
