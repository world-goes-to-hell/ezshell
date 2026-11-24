const { randomUUID } = require('node:crypto')

const MAX_IMAGES = 8
const MAX_SENT_IMAGES = 256
const IMAGE_LIMIT = '이미지는 한 메시지에 최대 8장까지 첨부할 수 있습니다.'
const fail = error => ({ ok: false, error })

function imagePreview(bitmap) {
  const { width, height } = bitmap.getSize()
  const thumbnail = Math.max(width, height) <= 280 ? bitmap
    : bitmap.resize(width >= height ? { width: 280 } : { height: 280 })
  return thumbnail.toPNG()
}

function createImageDrafts(clipboard) {
  const drafts = new Map()
  const reads = new Map()
  // Sent files already stay on disk until exit. Keep opaque ids for previews and explicit retries.
  let sent = new Map()

  function retain(retained, scope, id, file, retryable = false) {
    retained.delete(id)
    retained.set(id, { scope, file, retryable })
    if (retained.size > MAX_SENT_IMAGES) retained.delete(retained.keys().next().value)
  }

  function previewFile(scope, id) {
    const image = sent.get(id)
    return drafts.get(scope)?.get(id)?.file ?? (image && image.scope === scope ? image.file : null)
  }

  function remove(scope, ids) {
    const draft = drafts.get(scope)
    if (!draft) return
    for (const id of ids ?? draft.keys()) {
      const image = draft.get(id)
      if (!image) continue
      draft.delete(id)
      if (!image.sending) clipboard.discardImage(image.file)
    }
    if (!draft.size) drafts.delete(scope)
  }

  function clear(scope) {
    reads.delete(scope)
    remove(scope)
  }

  async function read(scope, canUse, unavailable, load) {
    if (reads.has(scope)) return fail('첨부할 이미지를 읽는 중입니다.')
    const token = {}
    reads.set(scope, token)
    const staged = []
    const current = () => reads.get(scope) === token && canUse()
    const room = () => MAX_IMAGES - (drafts.get(scope)?.size ?? 0) - staged.length
    function add(bitmap) {
      if (!current()) throw new Error(unavailable)
      if (!room()) throw new Error(IMAGE_LIMIT)
      staged.push({ id: randomUUID(), preview: imagePreview(bitmap), file: clipboard.storeImage(bitmap) })
    }
    try {
      const result = await load(add, room)
      if (!current()) return fail(unavailable)
      if (result?.kind === 'text') return result
      const draft = drafts.get(scope) ?? new Map()
      const images = staged.splice(0).map(({ id, file, preview }) => {
        draft.set(id, { file })
        return { id, preview }
      })
      if (images.length) drafts.set(scope, draft)
      return { ok: true, kind: 'images', images, ...(result?.text && { text: result.text }) }
    } catch (error) {
      return fail(error.code ? '첨부 이미지를 처리하지 못했습니다.' : error.message)
    } finally {
      for (const { file } of staged) clipboard.discardImage(file)
      if (reads.get(scope) === token) reads.delete(scope)
    }
  }

  function select(scope, ids, { retry = false, retainFor = null } = {}) {
    const missing = fail('이미지를 다시 첨부해 주세요.')
    if (!Array.isArray(ids) || ids.length > MAX_IMAGES || new Set(ids).size !== ids.length) return missing
    const draft = drafts.get(scope)
    const retained = sent
    const images = ids.map(id => retry ? retained.get(id) : draft?.get(id))
    if (images.some(image => !image)) return missing
    if (retry && images.some(image => image.scope !== scope || !image.retryable)) return missing
    if (images.some(image => image.sending)) return fail('다른 입력을 넣는 중입니다. 잠시 뒤 다시 시도해 주세요.')
    const files = images.map(image => image.file)
    return {
      ok: true, files,
      async send(deliver) {
        for (const image of images) image.sending = true
        let result
        try {
          result = await deliver()
          return result
        } finally {
          images.forEach((image, index) => {
            image.sending = false
            const id = ids[index]
            // Keep the file until app exit so the recipient can still open it after the draft closes.
            if (result?.ok) {
              if (!retry) draft.delete(id)
              if (retainFor) retain(retained, scope, id, image.file, retainFor === 'retry')
            } else if (!retry && draft.get(id) !== image) clipboard.discardImage(image.file)
          })
          if (draft && !draft.size && drafts.get(scope) === draft) drafts.delete(scope)
        }
      }
    }
  }

  return {
    clear, remove, select, previewFile,
    rememberCaptures(scope, attachments) {
      return attachments.map(({ file }) => {
        const id = randomUUID()
        retain(sent, scope, id, file)
        return id
      })
    },
    forgetSent(ids) { for (const id of ids) sent.delete(id) },
    clearAll() {
      reads.clear()
      for (const scope of drafts.keys()) remove(scope)
      sent = new Map()
    },
    paste: (scope, canUse, unavailable, { includeImageWithText = false } = {}) => read(scope, canUse, unavailable, async (add, room) => {
      const { text, image } = await clipboard.read({ includeImageWithText })
      if (!image) return { ok: true, kind: 'text', text }
      if (!room()) throw new Error(IMAGE_LIMIT)
      add(await clipboard.decodeImage(image))
      return { text }
    }),
    pick: (scope, canUse, unavailable, selectFiles) => read(scope, canUse, unavailable, async (add, room) => {
      if (!room()) throw new Error(IMAGE_LIMIT)
      const paths = await selectFiles()
      if (paths.length > room()) throw new Error(IMAGE_LIMIT)
      for (const path of paths) add(await clipboard.decodeImageFile(path))
    })
  }
}

module.exports = { createImageDrafts, imagePreview }
