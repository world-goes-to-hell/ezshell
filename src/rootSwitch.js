// "로그인 후 root 로 전환": on a freshly opened shell, run `su -` and answer its password prompt.
// The password is written only after a password prompt is seen, and only once: if su does not ask
// (already root, no su) it is never typed into the shell, where it would run as a command and be echoed.
// su does not echo the password, so it does not reach the terminal, the session log or the renderer.
// See docs/plan/2026-11-04-su-root-switch.md.

const ROOT_SWITCH_TIMEOUT_MS = 10000;
/** Only the end of the output matters; a long login banner is not kept */
const TAIL_CHARS = 4096;
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]|\u001b\][^\u0007]*\u0007/g;
/** A prompt waiting for input at the very end of the output: "Password:", "암호:", "비밀번호:" */
const PASSWORD_PROMPT = /(password|암호|비밀번호)[^\n]*[:：]\s*$/i;
const FAILURE = /(authentication failure|incorrect password|sorry|permission denied|does not exist|인증 실패|인증에 실패|잘못된 (암호|비밀번호))/i;
const SU_COMPLAINT = /^su: .+$/m;
/** A root shell prompt ends with # */
const ROOT_PROMPT = /#\s*$/;

/**
 * Resolves with { outcome }: 'switched' (root prompt after the password), 'failed' (su said no),
 * 'no-prompt' (su never asked; the password was not sent), 'unknown' (no answer after the password).
 * Never rejects; never includes the password in what it resolves with.
 */
function switchToRoot(stream, { password, timeoutMs = ROOT_SWITCH_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    let output = '';
    let isPasswordSent = false;
    let isDone = false;

    const finish = (outcome) => {
      if (isDone) return;
      isDone = true;
      clearTimeout(timer);
      stream.removeListener('data', onData);
      resolve({ outcome });
    };

    function onData(chunk) {
      output = (output + chunk.toString('utf8')).replace(ANSI, '').replace(/\r/g, '').slice(-TAIL_CHARS);
      if (!isPasswordSent) {
        // Before the password only su's own complaint counts ("su: user root does not exist"): a login
        // banner may well say "sorry" or "permission denied"
        if (SU_COMPLAINT.test(output)) return finish('failed');
        if (!PASSWORD_PROMPT.test(output)) return;
        isPasswordSent = true;
        output = '';
        stream.write(`${password}\r`);
        return;
      }
      if (FAILURE.test(output)) return finish('failed');
      if (ROOT_PROMPT.test(output)) finish('switched');
    }

    const timer = setTimeout(() => finish(isPasswordSent ? 'unknown' : 'no-prompt'), timeoutMs);
    stream.on('data', onData);
    stream.write('su -\r');
  });
}

module.exports = { switchToRoot, ROOT_SWITCH_TIMEOUT_MS };
