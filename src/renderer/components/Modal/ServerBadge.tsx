import './ConfirmDialog.css'

export function ServerBadge({ name, color }: { name: string; color?: string }) {
  return (
    <span className="confirm-server-badge">
      <span className="confirm-server-label">세션</span>
      {color && <span className="confirm-server-swatch" aria-hidden="true" style={{ backgroundColor: color }} />}
      <span className="confirm-server-name">{name}</span>
    </span>
  )
}
