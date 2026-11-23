// The overlay receives only the selected display's frozen image. It has no preload or Electron API.
// Marks on the chosen region (arrow, box, pen, text, badge, mosaic) come from quickCaptureEditor.js as source text.
const { EDITOR_SCRIPT } = require('./quickCaptureEditor.js')

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
  #review { position: absolute; z-index: 2; width: min(440px, calc(100% - 24px)); padding: 12px;
    max-height: calc(100% - 24px); overflow: auto;
    border: 1px solid #414d5f; border-radius: 10px; background: #1c2330; box-shadow: 0 8px 28px #0006; }
  #review label { display: block; margin-bottom: 7px; font-weight: 600; }
  #comment { display: block; width: 100%; height: 66px; resize: none; padding: 7px 9px; font: inherit;
    line-height: 1.4; color: inherit; background: #131820; border: 1px solid #475466; border-radius: 6px; }
  .actions { display: flex; justify-content: flex-end; gap: 6px; margin-top: 9px; }
  button { min-width: 60px; padding: 5px 12px; font: inherit; color: inherit; cursor: pointer;
    background: #293444; border: 1px solid #475466; border-radius: 6px; }
  button:hover { background: #354355; }
  #work { background: #356ad0; border-color: #5687e6; }
  #work:hover { background: #4074dc; }
  :is(button, textarea, select):focus-visible { outline: 2px solid #83acff; outline-offset: 1px; }
  :is(button, select):disabled { opacity: .55; cursor: default; }
  #project { width: 100%; padding: 6px 8px; color: inherit; color-scheme: dark; font: inherit;
    background: #131820; border: 1px solid #475466; border-radius: 6px; }
  #project-path, .agent-path { display: block; color: #b2c1d6; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #project-path { margin-top: 4px; }
  #agents { display: grid; gap: 5px; max-height: 202px; overflow: auto; }
  #agents:not(:empty) { margin-top: 8px; padding: 2px; }
  .agent { display: flex; align-items: center; justify-content: space-between; gap: 10px; text-align: left; padding: 7px 9px; }
  .agent-info { min-width: 0; }
  .agent-title { display: block; font-weight: 600; }
  .agent-send { color: #a9caff; white-space: nowrap; }
  #status { margin: 8px 0 0; color: #b2c1d6; }
  #status[data-error] { color: #ffb5ae; }
  #status:empty { display: none; }
  #ink { position: absolute; z-index: 1; cursor: crosshair; touch-action: none; }
  #ink[data-ink-tool="text"] { cursor: text; }
  #ink[data-ink-tool="badge"] { cursor: copy; }
  #tools { display: grid; gap: 6px; margin-bottom: 10px; padding-bottom: 10px; border-bottom: 1px solid #333f50; }
  .tool-row { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
  #tools button { min-width: 30px; height: 30px; padding: 0 7px; line-height: 1; }
  #tools button[aria-pressed="true"] { background: #356ad0; border-color: #83acff; }
  #tools .tool { font-size: 15px; }
  #tools .text-button { font-size: 12px; }
  #tools .swatch { min-width: 22px; width: 22px; height: 22px; padding: 0; border-radius: 50%; }
  #tools .swatch[aria-pressed="true"] { outline: 2px solid #fff; outline-offset: 1px; }
  #tools .weight span { display: block; width: 14px; background: currentColor; border-radius: 2px; }
  .tool-gap { flex: 1; }
  .ink-text { position: absolute; z-index: 3; min-width: 120px; padding: 1px 4px; background: #000a;
    border: 1px dashed #ffffffaa; border-radius: 3px; outline: none; }
</style>
<img id="snapshot" alt="" draggable="false">
<div id="hint">드래그해서 영역 선택 · Esc 취소</div>
<div id="selection" hidden></div>
<canvas id="ink" hidden></canvas>
<form id="review" aria-label="캡처 확인" hidden>
  <div id="review-comment">
    <div id="tools" role="toolbar" aria-label="표시 도구">
      <div class="tool-row">
        <button type="button" class="tool" data-tool="arrow" title="화살표 (A)" aria-label="화살표">↗</button>
        <button type="button" class="tool" data-tool="box" title="사각형 (R)" aria-label="사각형">▭</button>
        <button type="button" class="tool" data-tool="pen" title="펜 (P)" aria-label="펜">✎</button>
        <button type="button" class="tool" data-tool="text" title="글자 (T)" aria-label="글자">T</button>
        <button type="button" class="tool" data-tool="badge" title="번호 (N): 코멘트에 같은 번호 줄이 생깁니다" aria-label="번호">①</button>
        <button type="button" class="tool" data-tool="mosaic" title="모자이크 (M): 비밀번호·개인 정보 가리기" aria-label="모자이크">▦</button>
        <span class="tool-gap"></span>
        <button type="button" id="undo" class="tool" title="되돌리기 (Ctrl+Z)" aria-label="되돌리기">↶</button>
        <button type="button" id="redo" class="tool" title="다시 실행 (Ctrl+Y)" aria-label="다시 실행">↷</button>
      </div>
      <div class="tool-row">
        <button type="button" class="swatch" data-color="#ff3b30" style="background:#ff3b30" title="빨강" aria-label="빨강"></button>
        <button type="button" class="swatch" data-color="#ffcc00" style="background:#ffcc00" title="노랑" aria-label="노랑"></button>
        <button type="button" class="swatch" data-color="#34c759" style="background:#34c759" title="초록" aria-label="초록"></button>
        <button type="button" class="swatch" data-color="#0a84ff" style="background:#0a84ff" title="파랑" aria-label="파랑"></button>
        <button type="button" class="swatch" data-color="#ffffff" style="background:#ffffff" title="흰색" aria-label="흰색"></button>
        <button type="button" class="weight" data-width="2" title="가늘게" aria-label="가늘게"><span style="height:2px"></span></button>
        <button type="button" class="weight" data-width="4" title="보통" aria-label="보통"><span style="height:4px"></span></button>
        <button type="button" class="weight" data-width="7" title="굵게" aria-label="굵게"><span style="height:7px"></span></button>
        <span class="tool-gap"></span>
        <button type="button" id="clear-marks" class="text-button" title="표시를 모두 지웁니다">모두 지우기</button>
        <button type="button" id="reselect" class="text-button" title="표시를 버리고 영역을 다시 고릅니다">영역 다시</button>
      </div>
    </div>
    <label for="comment">코멘트 (선택)</label>
    <textarea id="comment" rows="2" placeholder="무엇이 문제이고 어떻게 바꿀지 적어 주세요"></textarea>
    <div class="actions">
      <button id="cancel" type="button">취소</button>
      <button id="copy" type="submit">복사</button>
      <button id="work" type="button">바로작업</button>
    </div>
  </div>
  <div id="picker" hidden>
    <label for="project">프로젝트 선택</label>
    <select id="project" aria-describedby="project-path"></select>
    <small id="project-path"></small>
    <div id="agents" role="group" aria-label="전송할 에이전트"></div>
    <div class="actions"><button id="back" type="button">뒤로</button></div>
  </div>
  <p id="status" role="status"></p>
</form>
<script>${EDITOR_SCRIPT}</script>
<script>
  const snapshot = document.querySelector('#snapshot')
  const box = document.querySelector('#selection')
  const review = document.querySelector('#review')
  const comment = document.querySelector('#comment')
  const reviewComment = document.querySelector('#review-comment')
  const picker = document.querySelector('#picker')
  const project = document.querySelector('#project')
  const projectPath = document.querySelector('#project-path')
  const agents = document.querySelector('#agents')
  const status = document.querySelector('#status')
  const back = document.querySelector('#back')
  const agentStates = { idle: '대기 중', working: '작업 중', blocked: '확인 대기', starting: '시작 중' }
  const point = event => ({
    x: Math.max(0, Math.min(innerWidth, event.clientX)),
    y: Math.max(0, Math.min(innerHeight, event.clientY))
  })
  window.setCaptureImage = async image => {
    snapshot.src = image
    await snapshot.decode()
  }
  window.pickCaptureRegion = () => {
    let start
    let pointer
    let selection
    let projects = []
    let accept
    const nextAction = () => new Promise(resolve => { accept = resolve })
    function submit(action) {
      if (!accept) return
      const resolve = accept
      accept = undefined
      resolve(action)
    }
    function message(text, error = false) {
      status.textContent = text
      status.toggleAttribute('data-error', error)
      placeReview()
    }
    function renderAgents(selectedAgent) {
      const chosen = projects.find(item => item.folder === project.value)
      projectPath.textContent = projectPath.title = chosen?.folder ?? ''
      const buttons = (chosen?.agents ?? []).map(agent => {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'agent'
        const who = (agent.kind === 'codex' ? 'Codex' : 'Claude Code') + ' · ' + agent.id
        button.setAttribute('aria-label', who + '에 전송')
        const info = document.createElement('span')
        info.className = 'agent-info'
        const title = document.createElement('span')
        title.className = 'agent-title'
        const state = agentStates[agent.status]
        title.textContent = state ? who + ' · ' + state : who
        const folder = document.createElement('small')
        folder.className = 'agent-path'
        folder.textContent = folder.title = agent.cwd
        info.append(title, folder)
        const send = document.createElement('span')
        send.className = 'agent-send'
        send.textContent = '전송'
        button.append(info, send)
        button.onclick = () => {
          if (!accept) return
          for (const control of [project, back, ...agents.children]) control.disabled = true
          message(who + '에 보내는 중…')
          submit({ action: 'send', agentId: agent.id, region: selection, comment: comment.value, image: window.captureEditor.exportImage() })
        }
        if (agent.id === selectedAgent) button.dataset.retry = ''
        return button
      })
      agents.replaceChildren(...buttons)
      placeReview()
    }
    window.chooseCaptureTarget = (options, error, selectedAgent) => {
      const previous = project.value
      projects = options
      const prompt = new Option('프로젝트를 선택하세요', '', true, true)
      prompt.disabled = true
      project.replaceChildren(prompt, ...projects.map(item => {
        const duplicate = projects.some(other => other !== item && other.name === item.name)
        return new Option(duplicate ? item.folder : item.name, item.folder)
      }))
      if (projects.length === 1) project.value = projects[0].folder
      else if (projects.some(item => item.folder === previous)) project.value = previous
      project.disabled = !projects.length
      back.disabled = false
      reviewComment.hidden = true
      picker.hidden = false
      renderAgents(selectedAgent)
      message(error || (projects.length ? '' : '열려 있는 에이전트가 없습니다.'), Boolean(error))
      const focus = agents.querySelector('[data-retry]') ?? (projects.length ? project : back)
      focus.focus()
      return nextAction()
    }
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
      window.captureEditor.start(selection, { onBadge: n => { comment.value = commentWithBadge(comment.value, n) } })
      placeReview()
      comment.focus()
    })
    document.body.addEventListener('pointercancel', clear)
    document.body.addEventListener('lostpointercapture', clear)
    window.addEventListener('resize', placeReview)
    review.addEventListener('submit', event => {
      event.preventDefault()
      if (selection && !reviewComment.hidden) submit({ action: 'copy', region: selection, comment: comment.value, image: window.captureEditor.exportImage() })
    })
    document.querySelector('#work').onclick = () => {
      if (!selection || !accept) return
      reviewComment.hidden = true
      message('프로젝트를 불러오는 중…')
      submit({ action: 'targets' })
    }
    project.onchange = () => { message(''); renderAgents() }
    back.onclick = () => {
      picker.hidden = true
      reviewComment.hidden = false
      message('')
      comment.focus()
    }
    document.querySelector('#reselect').onclick = () => {
      window.captureEditor.reset()
      selection = undefined
      box.hidden = true
      review.hidden = true
      delete document.body.dataset.review
      message('')
    }
    document.querySelector('#cancel').addEventListener('click', () => submit(null))
    document.addEventListener('contextmenu', event => {
      if (review.contains(event.target)) return
      event.preventDefault()
      submit(null)
    })
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !event.isComposing) submit(null)
    })
    return nextAction()
  }
</script>
</html>`

const OVERLAY_URL = 'data:text/html;charset=utf-8,' + encodeURIComponent(page)
module.exports = { OVERLAY_URL }
