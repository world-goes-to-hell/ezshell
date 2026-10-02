// Pieces the session gateway (sessionGateway.js) and background job channels (jobChannel.js) both use.
const { StringDecoder } = require('string_decoder')

/** How long to wait for a stopped channel to report that it closed */
const CLOSE_GRACE_MS = 2000
const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]/g
const CANCELLED_MESSAGE = '요청이 취소되었습니다.'
const DROPPED_MESSAGE = '서버와의 연결이 끊겼습니다.'
const OPEN_FAILED_MESSAGE = '명령을 실행할 채널을 열지 못했습니다.'

class GatewayError extends Error {
  constructor(userMessage, detail) {
    super(userMessage)
    this.userMessage = userMessage
    this.detail = detail
  }
}

/** An escape character that starts no complete sequence within this many characters is just dropped */
const MAX_HELD_SEQUENCE = 64
const ESC = '\x1b'

/**
 * Passes what a command prints to a watcher (the activity view) as it arrives: decoded without
 * splitting a multi-byte character, control sequences removed.
 * The start of a sequence that is cut off by the end of a chunk waits for the next chunk.
 * `push(piece)` takes the bytes to report; `end()` hands over whatever is still waiting.
 */
function createReporter(onOutput, stream) {
  if (typeof onOutput !== 'function') return { push() {}, end() {} }
  const decoder = new StringDecoder('utf8')
  let held = ''
  const emit = (text) => {
    if (text === '') return
    try {
      onOutput(stream, text)
    } catch {
      // Watching must never affect the command
    }
  }
  return {
    push(piece) {
      if (!piece || piece.length === 0) return
      const text = (held + decoder.write(piece)).replace(ANSI_PATTERN, '')
      // Complete sequences are gone, so a remaining escape character is an unfinished (or stray) one
      const cut = text.indexOf(ESC)
      if (cut === -1 || text.length - cut > MAX_HELD_SEQUENCE) {
        held = ''
        emit(text.split(ESC).join(''))
        return
      }
      held = text.slice(cut)
      emit(text.slice(0, cut))
    },
    end() {
      const rest = held.split(ESC).join('')
      held = ''
      emit(rest)
    }
  }
}

module.exports = { GatewayError, createReporter, ANSI_PATTERN, CLOSE_GRACE_MS, CANCELLED_MESSAGE, DROPPED_MESSAGE, OPEN_FAILED_MESSAGE }
