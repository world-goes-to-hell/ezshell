// The effect cards of 설정 > 테마 > 마우스 포인터 (names, one-line descriptions, icons from mockups/cursor-themes.html)
import type { ClickEffect, MoveEffect } from '../../lib/pointerPrefs'

export interface EffectCardInfo<T extends string> {
  id: T
  name: string
  description: string
  tag?: 'practical' | 'cute'
  /** A fixed SVG drawn from this file (never from settings or other input) */
  icon: string
}

const icon = (paths: string) =>
  `<svg width="30" height="30" viewBox="0 0 30 30" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`
const NONE_ICON = icon('<circle cx="15" cy="15" r="9"/><path d="M8.6 21.4L21.4 8.6"/>')

export const MOVE_EFFECT_CARDS: readonly EffectCardInfo<MoveEffect>[] = [
  { id: 'none', name: '없음', description: '효과 끔 (기본)', icon: NONE_ICON },
  { id: 'spot', name: '포인터 위치 강조', description: '부드러운 빛 고리. 발표·화면 공유용', tag: 'practical',
    icon: icon('<circle cx="15" cy="15" r="11" opacity=".5"/><circle cx="15" cy="15" r="6.5"/><circle cx="15" cy="15" r="1.5" fill="currentColor"/>') },
  { id: 'ghost', name: '네온 잔상', description: '포인터 모양 잔상이 짧게 남아 위치를 찾기 쉬움', tag: 'practical',
    icon: icon('<path d="M6 4v16l4-3.6 2.6 6 3-1.3-2.6-5.8h5.4z" opacity=".35"/><path d="M11 6v16l4-3.6 2.6 6 3-1.3-2.6-5.8h5.4z"/>') },
  { id: 'sparkle', name: '별가루 꼬리', description: '지나간 자리에 반짝이', tag: 'cute',
    icon: icon('<path d="M12 4l1.6 5.2L19 11l-5.4 1.8L12 18l-1.6-5.2L5 11l5.4-1.8z"/><path d="M22 16l.9 2.7 2.7.9-2.7.9L22 23l-.9-2.5-2.7-.9 2.7-.9z"/>') },
  { id: 'rainbow', name: '무지개 꼬리', description: '짧게 사라지는 색 꼬리', tag: 'cute',
    icon: icon('<path d="M4 22a11 11 0 0 1 22 0" stroke="#ff5c7a"/><path d="M8 22a7 7 0 0 1 14 0" stroke="#ffd23f"/><path d="M12 22a3 3 0 0 1 6 0" stroke="#4fd1a5"/>') },
  { id: 'comet', name: '혜성 꼬리', description: '빛나는 선이 길게 따라옴', tag: 'cute',
    icon: icon('<path d="M4 24C10 22 16 16 23 8" opacity=".5" stroke-width="5"/><path d="M4 24C10 22 16 16 23 8"/><circle cx="23" cy="8" r="2.6" fill="currentColor"/>') },
  { id: 'bubble', name: '비눗방울', description: '방울이 떠오르다 톡 터짐', tag: 'cute',
    icon: icon('<circle cx="11" cy="19" r="6"/><circle cx="21" cy="9" r="3.5"/><path d="M8.5 17a3 3 0 0 1 2-2" opacity=".6"/>') },
  { id: 'petal', name: '벚꽃 흩날림', description: '꽃잎이 살랑이며 떨어짐', tag: 'cute',
    icon: icon('<ellipse cx="10" cy="11" rx="5" ry="2.8" transform="rotate(-30 10 11)"/><ellipse cx="20" cy="19" rx="5" ry="2.8" transform="rotate(40 20 19)"/>') },
  { id: 'pixel', name: '픽셀 부스러기', description: '8비트 점이 흩어짐 (픽셀 세트와 잘 어울림)', tag: 'cute',
    icon: icon('<rect x="6" y="6" width="4" height="4" fill="currentColor"/><rect x="14" y="12" width="4" height="4" fill="currentColor"/><rect x="21" y="19" width="4" height="4" fill="currentColor"/><rect x="8" y="20" width="3" height="3" fill="currentColor"/>') },
  { id: 'paw', name: '고양이 발자국', description: '또각또각 발자국 (고양이 발바닥 세트와 짝)', tag: 'cute',
    icon: icon('<ellipse cx="15" cy="20" rx="5" ry="4"/><circle cx="8.5" cy="14" r="2"/><circle cx="12.5" cy="9.5" r="2"/><circle cx="17.5" cy="9.5" r="2"/><circle cx="21.5" cy="14" r="2"/>') }
]

export const CLICK_EFFECT_CARDS: readonly EffectCardInfo<ClickEffect>[] = [
  { id: 'none', name: '없음', description: '효과 끔 (기본)', icon: NONE_ICON },
  { id: 'press', name: '눌림 표시', description: '조준점이 조여 들며 클릭 위치를 정확히 표시', tag: 'practical',
    icon: icon('<path d="M15 3v6M15 21v6M3 15h6M21 15h6"/><circle cx="15" cy="15" r="1.5" fill="currentColor"/>') },
  { id: 'ripple', name: '클릭 물결', description: '누른 자리에 퍼지는 고리', tag: 'practical',
    icon: icon('<circle cx="15" cy="15" r="3"/><circle cx="15" cy="15" r="8" opacity=".7"/><circle cx="15" cy="15" r="12" opacity=".4"/>') },
  { id: 'pulse', name: '동심원 링 펄스', description: '굵은 링이 겹겹이 퍼짐', tag: 'practical',
    icon: icon('<circle cx="15" cy="15" r="4" stroke-width="3"/><circle cx="15" cy="15" r="9" stroke-width="2" opacity=".6"/><circle cx="15" cy="15" r="13" opacity=".3"/>') },
  { id: 'heart', name: '하트 퐁', description: '하트가 퐁 하고 떠오름', tag: 'cute',
    icon: icon('<path d="M15 25C5 18 5 9 10.3 9c2.2 0 3.9 1.4 4.7 3.2C15.8 10.4 17.5 9 19.7 9 25 9 25 18 15 25z"/>') },
  { id: 'firework', name: '폭죽 터짐', description: '색색 불꽃이 사방으로', tag: 'cute',
    icon: icon('<path d="M15 4v5M15 21v5M4 15h5M21 15h5M7.5 7.5l3.5 3.5M19 19l3.5 3.5M22.5 7.5L19 11M11 19l-3.5 3.5"/>') },
  { id: 'starpop', name: '별 팡', description: '별이 튀어나옴', tag: 'cute',
    icon: icon('<path d="M15 4l3 7 7.5.8-5.6 5 1.7 7.4L15 20.3 8.4 24.2l1.7-7.4-5.6-5L12 11z"/>') },
  { id: 'word', name: '톡! 말풍선', description: '톡 / 뿅 / 콕 중 하나가 무작위로 팡', tag: 'cute',
    icon: icon('<rect x="4" y="6" width="22" height="14" rx="7"/><path d="M12 20l3 5 3-5"/>') },
  { id: 'ink', name: '잉크 번짐', description: '물감이 퍼지듯 번졌다 사라짐', tag: 'cute',
    icon: icon('<circle cx="15" cy="15" r="6"/><circle cx="8" cy="12" r="3.5"/><circle cx="22" cy="18" r="4"/><circle cx="17" cy="6.5" r="2.5"/>') }
]
