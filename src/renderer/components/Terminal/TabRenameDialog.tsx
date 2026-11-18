import { useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'

interface TabRenameDialogProps {
  title: string
  onClose: () => void
  onSave: (title: string) => void
}

export function TabRenameDialog({ title, onClose, onSave }: TabRenameDialogProps) {
  const [name, setName] = useState(title)
  const inputRef = useRef<HTMLInputElement>(null)
  const trimmed = name.trim()

  return (
    <Dialog.Root open onOpenChange={open => { if (!open) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content
          className="modal-content tab-rename-dialog"
          aria-describedby={undefined}
          onOpenAutoFocus={event => {
            event.preventDefault()
            inputRef.current?.focus()
            inputRef.current?.select()
          }}
        >
          <Dialog.Title className="modal-title">탭 이름 변경</Dialog.Title>
          <form onSubmit={event => {
            event.preventDefault()
            if (trimmed) onSave(trimmed)
          }}>
            <div className="form-group">
              <label htmlFor="terminal-tab-name">탭 이름</label>
              <input ref={inputRef} id="terminal-tab-name" value={name} maxLength={500} onChange={event => setName(event.target.value)} />
            </div>
            <div className="modal-actions">
              <Dialog.Close asChild><button type="button" className="btn-secondary modal-btn">취소</button></Dialog.Close>
              <button type="submit" className="btn-primary modal-btn" disabled={!trimmed}>저장</button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
