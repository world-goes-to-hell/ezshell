import { useEffect, useRef, useState } from 'react'
import { toast } from '../../stores/toastStore'

interface InlineNameInputProps {
  initialValue: string
  /** Select only the part before the extension on focus, like Explorer does for files */
  selectBaseName?: boolean
  /** Resolve with an error message to keep editing, or null when done */
  onCommit: (value: string) => Promise<string | null>
  onCancel: () => void
}

/**
 * Text field used for rename / new folder inside the file list.
 * Key and mouse events stop here so the list's own shortcuts (Backspace, Ctrl+A, arrows,
 * drag) never fire while typing.
 */
export function InlineNameInput({ initialValue, selectBaseName, onCommit, onCancel }: InlineNameInputProps) {
  const [value, setValue] = useState(initialValue)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const busyRef = useRef(false)
  const doneRef = useRef(false)

  useEffect(() => {
    const input = inputRef.current
    if (!input) return
    input.focus()
    const dot = initialValue.lastIndexOf('.')
    const end = selectBaseName && dot > 0 ? dot : initialValue.length
    input.setSelectionRange(0, end)
  }, [initialValue, selectBaseName])

  const commit = async (fromBlur: boolean) => {
    if (busyRef.current || doneRef.current) return
    busyRef.current = true
    const message = await onCommit(value)
    busyRef.current = false
    if (message === null) {
      doneRef.current = true
      return
    }
    // Leaving the field with an invalid name gives up instead of trapping focus
    if (fromBlur) {
      doneRef.current = true
      toast.info('변경하지 않았습니다', message)
      onCancel()
      return
    }
    setError(message)
  }

  const cancel = () => {
    if (doneRef.current) return
    doneRef.current = true
    onCancel()
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation()
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Enter') {
      e.preventDefault()
      commit(false)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      cancel()
    }
  }

  const stop = (e: React.SyntheticEvent) => e.stopPropagation()

  return (
    <span className="inline-name-editor" onClick={stop} onDoubleClick={stop} onMouseDown={stop} onContextMenu={stop}>
      <input
        ref={inputRef}
        className={`inline-name-input ${error ? 'has-error' : ''}`}
        value={value}
        onChange={(e) => {
          setValue(e.target.value)
          setError(null)
        }}
        onKeyDown={handleKeyDown}
        onBlur={() => commit(true)}
        aria-label="이름"
        aria-invalid={Boolean(error)}
        spellCheck={false}
      />
      {error && <span className="inline-name-error" role="alert">{error}</span>}
    </span>
  )
}
