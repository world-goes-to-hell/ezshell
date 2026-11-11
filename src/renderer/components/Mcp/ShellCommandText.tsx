import { Fragment } from 'react'
import { highlightCodeLine, type ShellLine } from '../../lib/shellFormat'
import './ShellCommandText.css'

/**
 * A command laid out by lib/shellFormat: one command per line, parts in colour. Used by the MCP
 * activity log and the approval dialog; put it inside an element with class `sh-code`.
 */
export function ShellCommandText({ lines }: { lines: ShellLine[] }) {
  return (
    <>
      {lines.map((line, lineIndex) => (
        <Fragment key={lineIndex}>
          {lineIndex > 0 && `\n${'  '.repeat(line.indent)}`}
          {line.tokens.map((token, tokenIndex) => {
            if (token.kind === 'text' || token.kind === 'space') return token.text
            if (token.kind === 'heredoc') {
              // A heredoc body is another program's code (often Python): coloured, never changed
              return (
                <span key={tokenIndex} className="sh-heredoc">
                  {highlightCodeLine(token.text).map((part, partIndex) => (
                    part.kind === 'text' ? part.text : <span key={partIndex} className={`sh-${part.kind}`}>{part.text}</span>
                  ))}
                </span>
              )
            }
            return <span key={tokenIndex} className={`sh-${token.kind}`}>{token.text}</span>
          })}
        </Fragment>
      ))}
    </>
  )
}
