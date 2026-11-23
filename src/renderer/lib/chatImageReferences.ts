const imageReferences = /\[첨부이미지 ([1-9]\d*)\]/g

export const chatImageReference = (number: number) => `[첨부이미지 ${number}]`

/** The first reference to each image determines its position in the outgoing attachment list. */
export function resolveChatImages<T extends { number: number }>(draft: string, staged: readonly T[]) {
  const available = new Map(staged.map(image => [image.number, image]))
  const order = new Map<T, number>()
  let afterReference = 0
  let hasText = false
  const text = draft.replace(imageReferences, (reference, number, offset: number) => {
    const image = available.get(Number(number))
    if (!image) return reference
    hasText ||= Boolean(draft.slice(afterReference, offset).trim())
    afterReference = offset + reference.length
    const index = order.get(image) ?? order.size + 1
    order.set(image, index)
    return chatImageReference(index)
  })
  hasText ||= Boolean(draft.slice(afterReference).trim())
  return { text: hasText ? text.trim() : '', images: [...order.keys()] }
}

export function insertChatImages(value: string, start: number, end: number, images: readonly { number: number }[], comment: string) {
  const before = value.slice(0, start)
  const after = value.slice(end)
  const references = images.map(image => chatImageReference(image.number)).join(' ')
  const body = comment ? `${references}\n${comment}` : references
  const prefix = /\S$/.test(before) ? ' ' : ''
  const suffix = !after || /^\S/.test(after) ? ' ' : ''
  const inserted = prefix + body + suffix
  return { text: before + inserted + after, caret: start + inserted.length }
}
