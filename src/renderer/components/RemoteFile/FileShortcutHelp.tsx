import { useState } from 'react'
import * as Tooltip from '@radix-ui/react-tooltip'
import { RiKeyboardLine } from 'react-icons/ri'
import { shortcutLabel } from '../../lib/shortcutModifiers'

const shortcutsByView = {
  editor: [
    [shortcutLabel(['Ctrl', 'F']), '찾기'],
    [shortcutLabel(['Ctrl', 'H']), '바꾸기'],
    [shortcutLabel(['Ctrl', 'G']), '줄 이동'],
    [shortcutLabel(['Ctrl', 'S']), '저장']
  ],
  log: [
    ['F8', '오류·경고 이동'],
    ['F9', '기준점 이동'],
    [shortcutLabel(['Alt', '휠']), '이전·다음 항목으로 이동'],
    ['Ctrl+휠', '화면 배율'],
    [shortcutLabel(['Ctrl', 'M']), '기준점 찍기']
  ]
} as const

export function FileShortcutHelp({ view }: { view: keyof typeof shortcutsByView }) {
  const [open, setOpen] = useState(false)
  const shortcuts = shortcutsByView[view]
  const label = '단축키 설명 보기'

  return (
    <Tooltip.Provider delayDuration={250}>
      <Tooltip.Root open={open} onOpenChange={setOpen}>
        <Tooltip.Trigger asChild>
          <button type="button" className="remote-file-icon-btn remote-file-shortcut-help" aria-label={label}
            onClick={event => { event.preventDefault(); setOpen(true) }}>
            <RiKeyboardLine size={14} aria-hidden="true" />
            <span>{label}</span>
          </button>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content className="remote-file-shortcut-tooltip" side="top" align="end" sideOffset={8} collisionPadding={8}
            aria-label={shortcuts.map(([keys, action]) => `${keys} ${action}`).join(' · ')}>
            <dl>
              {shortcuts.map(([keys, action]) => (
                <div key={keys} className="remote-file-shortcut-row">
                  <dt><kbd>{keys}</kbd></dt>
                  <dd>{action}</dd>
                </div>
              ))}
            </dl>
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  )
}
