/**
 * Holds output of SSH channels that arrives before its pane can show it.
 *
 * A split pane learns its stream id only when `sshCreateShell` resolves, and creates its xterm
 * after that, but the main process forwards channel output as soon as the channel opens. The
 * login banner and the first prompt usually arrive in that gap. Until its id is known the pane
 * cannot tell its chunks from other panes', so chunks are kept per stream.
 */

// The banner and first prompt are small; this only guards against a pane that never finishes opening
const DEFAULT_MAX_CHARS_PER_STREAM = 256 * 1024

export interface EarlyStreamBuffer {
  push: (streamId: string, data: string) => void
  /** The stream's chunks joined in arrival order; everything held for every stream is dropped */
  take: (streamId: string) => string
}

export function createEarlyStreamBuffer(maxCharsPerStream = DEFAULT_MAX_CHARS_PER_STREAM): EarlyStreamBuffer {
  let chunks = new Map<string, { parts: string[]; size: number }>()

  return {
    push(streamId, data) {
      const held = chunks.get(streamId) ?? { parts: [], size: 0 }
      if (held.size + data.length > maxCharsPerStream) {
        // Stop here for good: a later small chunk after a dropped one would leave a gap mid escape sequence
        chunks.set(streamId, { parts: held.parts, size: Infinity })
        return
      }
      chunks.set(streamId, { parts: [...held.parts, data], size: held.size + data.length })
    },
    take(streamId) {
      const text = chunks.get(streamId)?.parts.join('') ?? ''
      chunks = new Map()
      return text
    }
  }
}
