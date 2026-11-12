import { Fragment } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { RiGiftLine } from 'react-icons/ri'
import { notesFromFiles, parseMarkdown, type Block, type Inline, type VersionNotes } from '../../lib/releaseNotes'
import './WhatsNewDialog.css'

/** release-notes/<version>.md, bundled at build time */
export const BUNDLED_NOTES = notesFromFiles(
  import.meta.glob('../../../../release-notes/*.md', { query: '?raw', import: 'default', eager: true })
)

function Inlines({ items }: { items: Inline[] }) {
  return (
    <>
      {items.map((item, index) => {
        if (item.type === 'code') return <code key={index}>{item.text}</code>
        if (item.type === 'bold') return <strong key={index}>{item.text}</strong>
        return <Fragment key={index}>{item.text}</Fragment>
      })}
    </>
  )
}

function Blocks({ blocks }: { blocks: Block[] }) {
  return (
    <>
      {blocks.map((block, index) => {
        if (block.type === 'heading') {
          const Tag = block.level === 2 ? 'h3' : 'h4'
          return <Tag key={index}><Inlines items={block.inlines} /></Tag>
        }
        if (block.type === 'list') {
          return (
            <ul key={index}>
              {block.items.map((item, i) => (
                <li key={i} className={item.depth ? 'is-nested' : undefined}><Inlines items={item.inlines} /></li>
              ))}
            </ul>
          )
        }
        return <p key={index}><Inlines items={block.inlines} /></p>
      })}
    </>
  )
}

interface WhatsNewDialogProps {
  entries: VersionNotes[]
  onClose: () => void
}

/** "업데이트 내용": notes of the versions installed since the user last looked, newest first */
export function WhatsNewDialog({ entries, onClose }: WhatsNewDialogProps) {
  const [newest] = entries
  return (
    <Dialog.Root open onOpenChange={(isOpen) => { if (!isOpen) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="modal-content whats-new-dialog" aria-describedby={undefined}>
          <Dialog.Title className="modal-title">
            <RiGiftLine size={18} aria-hidden="true" />
            ezShell {newest.version} 업데이트 내용
          </Dialog.Title>
          <div className="whats-new-body">
            {entries.map(entry => (
              <section key={entry.version} className="whats-new-version">
                {entries.length > 1 && <h2>{entry.version}</h2>}
                <Blocks blocks={parseMarkdown(entry.markdown)} />
              </section>
            ))}
          </div>
          <div className="modal-actions">
            <button type="button" className="btn-primary modal-btn" onClick={onClose} autoFocus>확인</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
