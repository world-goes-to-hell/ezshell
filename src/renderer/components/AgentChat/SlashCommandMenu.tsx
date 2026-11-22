// The list over the chat composer while the draft is a slash command being typed ("/co"): the CLI's own
// commands and the user's (lib/slashCommands.ts). ↑↓ move, Enter / Tab pick, Esc closes; the composer
// handles the keys (AgentChatCover.tsx) and keeps the focus.
import { useEffect, useRef } from 'react'
import type { SlashCommand } from '../../lib/slashCommands'

const SOURCE_LABELS = { builtin: null, user: '내 명령', project: '프로젝트' } as const

export function SlashCommandMenu({ id, commands, active, onPick, onHover }: {
  id: string
  commands: SlashCommand[]
  active: number
  onPick: (command: SlashCommand) => void
  onHover: (index: number) => void
}) {
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  return (
    <div ref={listRef} className="agent-chat-slash" id={id} role="listbox" aria-label="슬래시 명령">
      {commands.map((command, index) => {
        const source = SOURCE_LABELS[command.source]
        return (
          <div
            key={command.name}
            id={`${id}-${index}`}
            data-index={index}
            role="option"
            aria-selected={index === active}
            className={`agent-chat-slash-item${index === active ? ' is-active' : ''}`}
            // Keep the focus in the composer
            onMouseDown={event => event.preventDefault()}
            onMouseEnter={() => onHover(index)}
            onClick={() => onPick(command)}
          >
            <span className="agent-chat-slash-name">{command.name}</span>
            {command.args && <span className="agent-chat-slash-args">{command.args}</span>}
            <span className="agent-chat-slash-desc">{command.description}</span>
            {command.screen && <span className="agent-chat-slash-tag" title="CLI 의 화면이 열려 그동안 터미널로 보여 줍니다">터미널 화면</span>}
            {source && <span className="agent-chat-slash-tag">{source}</span>}
          </div>
        )
      })}
    </div>
  )
}
