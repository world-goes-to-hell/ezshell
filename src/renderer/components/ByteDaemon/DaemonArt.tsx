import { useMemo } from 'react'
import { artMarkup, statusIconMarkup, type ArtKey, type DaemonFace } from '../../lib/byteDaemonArt'

/** A character or object of the Byte Daemon game. The markup is this app's own constant SVG (lib/byteDaemonArt.ts) */
export function DaemonArt({ name, size = 48, face, className }: { name: ArtKey; size?: number; face?: DaemonFace; className?: string }) {
  const markup = useMemo(() => artMarkup(name, face), [name, face])
  return (
    <svg className={`bd-art${className ? ` ${className}` : ''}`} width={size} height={size} viewBox="0 0 64 64"
      aria-hidden="true" focusable="false" dangerouslySetInnerHTML={{ __html: markup }} />
  )
}

/** The 16px daemon of the status bar */
export function DaemonStatusIcon({ asleep, className }: { asleep: boolean; className?: string }) {
  const markup = useMemo(() => statusIconMarkup(asleep), [asleep])
  return (
    <svg className={className} width={16} height={16} viewBox="0 0 16 16" aria-hidden="true" focusable="false"
      dangerouslySetInnerHTML={{ __html: markup }} />
  )
}
