// The overlay receives only the selected display's frozen image. It has no preload or Electron API.
const page = `<!doctype html>
<html lang="ko">
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>ezShell 영역 캡처</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; }
  body { background: #131820; font: 13px 'Segoe UI', sans-serif; color: #fff; }
  body:not([data-review]) { cursor: crosshair; user-select: none; touch-action: none; }
  img { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
  body:not([data-selecting])::after { content: ''; position: absolute; inset: 0; background: #10151c59; pointer-events: none; }
  #selection { position: absolute; outline: 1px solid #fff; box-shadow: 0 0 0 9999px #10151c73; pointer-events: none; }
  #hint { position: absolute; z-index: 1; top: 20px; left: 50%; transform: translateX(-50%); white-space: nowrap;
    padding: 8px 12px; border: 1px solid #ffffff30; border-radius: 7px; background: #1c2330; pointer-events: none; }
  body[data-selecting] #hint { display: none; }
  #review { position: absolute; z-index: 2; width: min(340px, calc(100% - 24px)); padding: 12px;
    border: 1px solid #414d5f; border-radius: 10px; background: #1c2330; box-shadow: 0 8px 28px #0006; }
  #review label { display: block; margin-bottom: 7px; font-weight: 600; }
  #comment { display: block; width: 100%; height: 66px; resize: none; padding: 7px 9px; font: inherit;
    line-height: 1.4; color: inherit; background: #131820; border: 1px solid #475466; border-radius: 6px; }
  #actions { display: flex; justify-content: flex-end; gap: 6px; margin-top: 9px; }
  button { min-width: 60px; padding: 5px 12px; font: inherit; color: inherit; cursor: pointer;
    background: #293444; border: 1px solid #475466; border-radius: 6px; }
  button:hover { background: #354355; }
  button[type='submit'] { background: #356ad0; border-color: #5687e6; }
  button[type='submit']:hover { background: #4074dc; }
  :is(button, textarea):focus-visible { outline: 2px solid #83acff; outline-offset: 1px; }
</style>
<img id="snapshot" alt="" draggable="false">
<div id="hint">드래그해서 영역 선택 · Esc 취소</div>
<div id="selection" hidden></div>
<form id="review" aria-labelledby="comment-label" hidden>
  <label id="comment-label" for="comment">코멘트 (선택)</label>
  <textarea id="comment" rows="2"></textarea>
  <div id="actions">
    <button id="cancel" type="button">취소</button>
    <button type="submit">확인</button>
  </div>
</form>
<script>
  const snapshot = document.querySelector('#snapshot')
  const box = document.querySelector('#selection')
  const review = document.querySelector('#review')
  const comment = document.querySelector('#comment')
  const point = event => ({
    x: Math.max(0, Math.min(innerWidth, event.clientX)),
    y: Math.max(0, Math.min(innerHeight, event.clientY))
  })
  window.setCaptureImage = async image => {
    snapshot.src = image
    await snapshot.decode()
  }
  window.pickCaptureRegion = () => new Promise(resolve => {
    let start
    let pointer
    let selection
    function update(event) {
      const end = point(event)
      const left = Math.min(start.x, end.x)
      const top = Math.min(start.y, end.y)
      const width = Math.abs(start.x - end.x)
      const height = Math.abs(start.y - end.y)
      const region = { left: left / innerWidth, top: top / innerHeight, width: width / innerWidth, height: height / innerHeight }
      for (const [edge, value] of Object.entries(region)) box.style[edge] = value * 100 + '%'
      return region
    }
    function clear(event) {
      if (event.pointerId !== pointer) return
      start = undefined
      pointer = undefined
      box.hidden = true
      delete document.body.dataset.selecting
    }
    function placeReview() {
      if (!selection) return
      const bounds = box.getBoundingClientRect()
      const { offsetWidth: width, offsetHeight: height } = review
      const gap = 12
      const clamp = (value, limit) => Math.max(gap, Math.min(value, limit - gap))
      let left = clamp(bounds.left, innerWidth - width)
      let top = innerHeight - height - gap
      if (bounds.bottom + height + gap * 2 <= innerHeight) top = bounds.bottom + gap
      else if (bounds.top >= height + gap * 2) top = bounds.top - height - gap
      else if (bounds.right + width + gap * 2 <= innerWidth) {
        left = bounds.right + gap
        top = bounds.top
      } else if (bounds.left >= width + gap * 2) {
        left = bounds.left - width - gap
        top = bounds.top
      }
      review.style.left = left + 'px'
      review.style.top = clamp(top, innerHeight - height) + 'px'
    }
    document.body.addEventListener('pointerdown', event => {
      if (event.button !== 0 || start || selection) return
      start = point(event)
      pointer = event.pointerId
      document.body.setPointerCapture(pointer)
      document.body.dataset.selecting = ''
      box.hidden = false
      update(event)
    })
    document.body.addEventListener('pointermove', event => {
      if (start && event.pointerId === pointer) update(event)
    })
    document.body.addEventListener('pointerup', event => {
      if (!start || event.pointerId !== pointer) return
      const region = update(event)
      if (!region.width || !region.height) return clear(event)
      selection = region
      start = undefined
      pointer = undefined
      document.body.dataset.review = ''
      review.hidden = false
      placeReview()
      comment.focus()
    })
    document.body.addEventListener('pointercancel', clear)
    document.body.addEventListener('lostpointercapture', clear)
    window.addEventListener('resize', placeReview)
    review.addEventListener('submit', event => {
      event.preventDefault()
      if (selection) resolve({ region: selection, comment: comment.value })
    })
    document.querySelector('#cancel').addEventListener('click', () => resolve(null))
    document.addEventListener('contextmenu', event => {
      if (review.contains(event.target)) return
      event.preventDefault()
      resolve(null)
    })
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !event.isComposing) resolve(null)
    })
  })
</script>
</html>`

const OVERLAY_URL = 'data:text/html;charset=utf-8,' + encodeURIComponent(page)
module.exports = { OVERLAY_URL }
