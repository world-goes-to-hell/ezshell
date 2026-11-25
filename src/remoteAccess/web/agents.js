// Read and control the PC's agent chat from the phone. Server text is always added as DOM text.
(() => {
  'use strict'
  const ns = (window.ezRemote = window.ezRemote || {})
  const MAX_TEXT = 16_000
  const MAX_ITEMS = 3000
  const ARM_MS = 800
  let nextRequest = 0
  const ACCESS_OFF = '휴대폰에서 에이전트 쓰기가 꺼져 있습니다. PC 설정의 원격 접속에서 켜 주세요.'
  const AGENT_CHANGED = 'PC에서 에이전트 세션이 바뀌었습니다.'
  const PROVIDERS = { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity' }
  // Provider logos and status marks from the desktop (24×24 paths, as in quickCaptureOverlay.js).
  const AGENT_ICON_PATHS = {
    "claude": "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z",
    "codex": "M11 4C11.6487 4 12.2498 4.20569 12.7411 4.55646C11.4486 5.22914 10.2602 6.07623 8.99996 6.80385L9.99996 8.5359C11.575 7.62654 13.0517 6.48541 14.7608 5.83037C16.1134 5.31198 17.681 5.83976 18.4282 7.13398C18.7526 7.69582 18.8749 8.31917 18.8168 8.92006C17.588 8.13708 16.2602 7.53146 15 6.80385L14 8.5359C15.575 9.44525 17.3016 10.1536 18.7234 11.3061C19.8487 12.2183 20.1754 13.8398 19.4282 15.134C19.1037 15.696 18.6249 16.1137 18.0752 16.3638C18.1385 14.9081 18 13.4553 18 12H16C16 13.8184 16.2498 15.6685 15.9626 17.4758C15.7353 18.9063 14.4944 20 13 20C12.351 20 11.7498 19.7942 11.2584 19.4432C12.5508 18.7701 13.7396 17.9238 15 17.1962L14 15.4641C12.4252 16.3733 10.9478 17.5147 9.23912 18.1696C7.88657 18.688 6.31898 18.1602 5.57176 16.866C5.24729 16.304 5.12493 15.6805 5.18316 15.0794C6.41224 15.8621 7.73964 16.4685 8.99997 17.1962L9.99997 15.4641C8.42517 14.5549 6.69801 13.8462 5.27649 12.6939C4.15128 11.7817 3.82455 10.1602 4.57176 8.86602C4.89624 8.30402 5.37506 7.88628 5.9247 7.63618C5.86145 9.09192 5.99997 10.5447 5.99997 12H7.99997C7.99997 10.1816 7.75013 8.33148 8.03733 6.52422C8.26467 5.09369 9.50554 4 11 4ZM14.7925 3.74171C13.8765 2.67659 12.5176 2 11 2C8.7782 2 6.89621 3.44833 6.24435 5.45243C4.86393 5.71314 3.59851 6.55175 2.83971 7.86602C1.72883 9.79013 2.04213 12.1442 3.4518 13.7107C2.98737 15.0366 3.08092 16.5518 3.83971 17.866C4.95059 19.7901 7.14589 20.6958 9.20742 20.2583C10.1234 21.3234 11.4824 22 13 22C15.2217 22 17.1037 20.5517 17.7556 18.5476C19.136 18.2869 20.4014 17.4482 21.1602 16.134C22.2711 14.2099 21.9578 11.8559 20.5481 10.2893C21.0126 8.96345 20.919 7.44825 20.1602 6.13398C19.0493 4.20987 16.854 3.30419 14.7925 3.74171Z",
    "antigravity": "M3.91762 8.03672C3.32984 9.2334 3 10.5794 3 12C3 16.9705 7.02944 21 12 21C13.4216 21 14.7684 20.6697 15.9657 20.0812C16.8385 20.4545 17.6848 20.6993 18.4564 20.7622C19.3582 20.8357 20.3 20.6666 20.9818 19.9848C21.7339 19.2327 21.8625 18.169 21.7279 17.1728C21.6052 16.2639 21.2481 15.2539 20.726 14.2116C20.9051 13.5031 21 12.762 21 12C21 7.02942 16.9706 2.99998 12 2.99998C11.2389 2.99998 10.4987 3.09467 9.79103 3.27331C8.7474 2.74993 7.73605 2.39184 6.8261 2.26846C5.82897 2.13327 4.76406 2.26141 4.01121 3.01425C3.3287 3.69676 3.16001 4.63968 3.2341 5.54245C3.29752 6.31512 3.54313 7.16259 3.91762 8.03672ZM5.3224 5.96587C5.2734 5.75333 5.24204 5.55727 5.2274 5.37885C5.17928 4.79255 5.31727 4.53661 5.42543 4.42846C5.54452 4.30937 5.84797 4.15415 6.55739 4.25033C6.75482 4.2771 6.96951 4.32201 7.2 4.38559C6.50364 4.82539 5.87203 5.35796 5.3224 5.96587ZM19.6124 16.8031C19.6751 17.0317 19.7195 17.2446 19.7459 17.4405C19.8416 18.1487 19.6865 18.4516 19.5676 18.5706C19.4595 18.6786 19.204 18.8165 18.6189 18.7688C18.4419 18.7543 18.2475 18.7234 18.0368 18.6751C18.6427 18.1269 19.1736 17.4972 19.6124 16.8031ZM15.8812 17.8265C14.2046 16.9483 12.2571 15.5027 10.3752 13.6209C8.4954 11.7411 7.05092 9.79573 6.17241 8.1204C7.06357 6.78477 8.40124 5.77324 9.96933 5.29879C10.6108 5.10469 11.2923 4.99998 12 4.99998C15.866 4.99998 19 8.13399 19 12C19 12.7084 18.8951 13.3905 18.7006 14.0326C18.2261 15.5992 17.2155 16.9357 15.8812 17.8265ZM13.6052 18.8153C13.0901 18.9361 12.5528 19 12 19C8.13401 19 5 15.866 5 12C5 11.4478 5.06377 10.911 5.18429 10.3964C6.14883 11.9131 7.43475 13.5089 8.96096 15.0351C10.489 16.5631 12.0868 17.8503 13.6052 18.8153Z",
    "idle": "M12 22C6.47715 22 2 17.5228 2 12C2 6.47715 6.47715 2 12 2C17.5228 2 22 6.47715 22 12C22 17.5228 17.5228 22 12 22ZM12 20C16.4183 20 20 16.4183 20 12C20 7.58172 16.4183 4 12 4C7.58172 4 4 7.58172 4 12C4 16.4183 7.58172 20 12 20ZM12 15C10.3431 15 9 13.6569 9 12C9 10.3431 10.3431 9 12 9C13.6569 9 15 10.3431 15 12C15 13.6569 13.6569 15 12 15Z",
    "working": "M12 22C6.47715 22 2 17.5228 2 12C2 6.47715 6.47715 2 12 2C17.5228 2 22 6.47715 22 12C22 17.5228 17.5228 22 12 22ZM12 20C16.4183 20 20 16.4183 20 12C20 7.58172 16.4183 4 12 4C7.58172 4 4 7.58172 4 12C4 16.4183 7.58172 20 12 20ZM10.6219 8.41459L15.5008 11.6672C15.6846 11.7897 15.7343 12.0381 15.6117 12.2219C15.5824 12.2658 15.5447 12.3035 15.5008 12.3328L10.6219 15.5854C10.4381 15.708 10.1897 15.6583 10.0672 15.4745C10.0234 15.4088 10 15.3316 10 15.2526V8.74741C10 8.52649 10.1791 8.34741 10.4 8.34741C10.479 8.34741 10.5562 8.37078 10.6219 8.41459Z",
    "blocked": "M10 3H14C18.4183 3 22 6.58172 22 11C22 15.4183 18.4183 19 14 19V22.5C9 20.5 2 17.5 2 11C2 6.58172 5.58172 3 10 3ZM12 17H14C17.3137 17 20 14.3137 20 11C20 7.68629 17.3137 5 14 5H10C6.68629 5 4 7.68629 4 11C4 14.61 6.46208 16.9656 12 19.4798V17Z",
    "starting": "M6 4H4V2H20V4H18V6C18 7.61543 17.1838 8.91468 16.1561 9.97667C15.4532 10.703 14.598 11.372 13.7309 12C14.598 12.628 15.4532 13.297 16.1561 14.0233C17.1838 15.0853 18 16.3846 18 18V20H20V22H4V20H6V18C6 16.3846 6.81616 15.0853 7.8439 14.0233C8.54682 13.297 9.40202 12.628 10.2691 12C9.40202 11.372 8.54682 10.703 7.8439 9.97667C6.81616 8.91468 6 7.61543 6 6V4ZM8 4V6C8 6.88457 8.43384 7.71032 9.2811 8.58583C10.008 9.33699 10.9548 10.0398 12 10.7781C13.0452 10.0398 13.992 9.33699 14.7189 8.58583C15.5662 7.71032 16 6.88457 16 6V4H8ZM12 13.2219C10.9548 13.9602 10.008 14.663 9.2811 15.4142C8.43384 16.2897 8 17.1154 8 18V20H16V18C16 17.1154 15.5662 16.2897 14.7189 15.4142C13.992 14.663 13.0452 13.9602 12 13.2219Z",
    "sleeping": "M10 7C10 10.866 13.134 14 17 14C18.9584 14 20.729 13.1957 21.9995 11.8995C22 11.933 22 11.9665 22 12C22 17.5228 17.5228 22 12 22C6.47715 22 2 17.5228 2 12C2 6.47715 6.47715 2 12 2C12.0335 2 12.067 2 12.1005 2.00049C10.8043 3.27098 10 5.04157 10 7ZM4 12C4 16.4183 7.58172 20 12 20C15.0583 20 17.7158 18.2839 19.062 15.7621C18.3945 15.9187 17.7035 16 17 16C12.0294 16 8 11.9706 8 7C8 6.29648 8.08133 5.60547 8.2379 4.938C5.71611 6.28423 4 8.9417 4 12Z",
    "ended": "M12 22C6.47715 22 2 17.5228 2 12C2 6.47715 6.47715 2 12 2C17.5228 2 22 6.47715 22 12C22 17.5228 17.5228 22 12 22ZM12 20C16.4183 20 20 16.4183 20 12C20 7.58172 16.4183 4 12 4C7.58172 4 4 7.58172 4 12C4 16.4183 7.58172 20 12 20ZM9 9H15V15H9V9Z",
    "error": "M12 22C6.47715 22 2 17.5228 2 12C2 6.47715 6.47715 2 12 2C17.5228 2 22 6.47715 22 12C22 17.5228 17.5228 22 12 22ZM12 20C16.4183 20 20 16.4183 20 12C20 7.58172 16.4183 4 12 4C7.58172 4 4 7.58172 4 12C4 16.4183 7.58172 20 12 20ZM11 15H13V17H11V15ZM11 7H13V13H11V7Z",
    "unknown": "M12 22C6.47715 22 2 17.5228 2 12C2 6.47715 6.47715 2 12 2C17.5228 2 22 6.47715 22 12C22 17.5228 17.5228 22 12 22ZM12 20C16.4183 20 20 16.4183 20 12C20 7.58172 16.4183 4 12 4C7.58172 4 4 7.58172 4 12C4 16.4183 7.58172 20 12 20Z"
  }
  const STATUSES = {
    idle: '쉬는 중', working: '작업 중', blocked: '확인 대기', starting: '시작 중',
    sleeping: '잠듦', ended: '종료됨', error: '오류', unknown: '상태 확인 중'
  }
  const sendClock = new Intl.DateTimeFormat('ko-KR', { hour: 'numeric', minute: '2-digit', hour12: true })
  const fullChatDate = new Intl.DateTimeFormat('ko-KR', { dateStyle: 'full', timeStyle: 'medium' })

  function el(tag, className, text) {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text != null) node.textContent = text
    return node
  }

  function chipIcon(className, pathData) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('class', className)
    svg.setAttribute('viewBox', '0 0 24 24')
    svg.setAttribute('aria-hidden', 'true')
    const path = document.createElementNS(svg.namespaceURI, 'path')
    path.setAttribute('d', pathData)
    svg.append(path)
    return svg
  }

  function button(text, className, action) {
    const node = el('button', className, text)
    node.type = 'button'
    node.addEventListener('click', action)
    return node
  }

  function statusOf(agent) {
    if (agent.waitingApproval) return 'blocked'
    return Object.hasOwn(STATUSES, agent.status) ? agent.status : 'unknown'
  }

  const providerOf = agent => Object.hasOwn(PROVIDERS, agent.kind) ? PROVIDERS[agent.kind] : '에이전트'
  const nameOf = agent => {
    const role = agent.role?.trim()
    const base = agent.name || agent.agentId || '에이전트'
    return role ? `${role} · ${base}` : base
  }

  function setStatus(node, status) {
    if (node.dataset.status === status) return
    node.dataset.status = status
    node.textContent = STATUSES[status]
  }

  function projectGroups(agents, reviewTabs, projects) {
    const groups = new Map()
    function groupOf(item, folder) {
      const id = item.project?.id ?? (folder ? `folder:${folder}` : '')
      const name = item.project?.name || folder || '기타 로컬 작업'
      if (!groups.has(id)) groups.set(id, { id, name, agents: [], tabs: [], servers: [] })
      return groups.get(id)
    }
    for (const project of projects) groupOf({ project }).servers.push(...project.servers)
    for (const agent of agents) groupOf(agent, agent.folderName).agents.push(agent)
    for (const tab of reviewTabs) groupOf(tab, tab.folder).tabs.push(tab)
    return [...groups.values()].sort((a, b) => Number(!a.id) - Number(!b.id) || a.name.localeCompare(b.name, 'ko'))
  }

  function appendInline(node, text) {
    let offset = 0
    for (const match of text.matchAll(/`([^`\n]+)`|\*\*([^*\n]+)\*\*/g)) {
      node.append(document.createTextNode(text.slice(offset, match.index)),
        match[1] === undefined ? el('strong', '', match[2]) : el('code', '', match[1]))
      offset = match.index + match[0].length
    }
    node.append(document.createTextNode(text.slice(offset)))
  }

  function appendAnswer(node, text) {
    let offset = 0
    for (const block of text.matchAll(/(?:^|\n)```[^\n]*\n([\s\S]*?)\n```(?=\n|$)/g)) {
      appendInline(node, text.slice(offset, block.index))
      const pre = el('pre')
      pre.append(el('code', '', block[1]))
      node.append(pre)
      offset = block.index + block[0].length
      if (text[offset] === '\n') offset++
    }
    appendInline(node, text.slice(offset))
  }

  function appendTimestamp(node, value) {
    if (!Number.isFinite(value)) return
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return
    const time = el('time', 'remote-chat-timestamp', sendClock.format(date))
    time.dateTime = date.toISOString()
    time.title = fullChatDate.format(date)
    node.append(time)
  }

  const isCount = value => Number.isFinite(value) && value >= 0

  function tokenCount(value) {
    if (value < 10_000) return value.toLocaleString('ko-KR')
    const man = value / 10_000
    return `${man < 100 ? man.toFixed(1).replace(/\.0$/, '') : Math.round(man)}만`
  }

  function turnUsageText(usage) {
    if (!isCount(usage?.input) || !isCount(usage?.output)) return ''
    const parts = [`토큰 입력 ${tokenCount(usage.input)}`, `출력 ${tokenCount(usage.output)}`]
    if (usage.input > 0 && isCount(usage.cached) && usage.cached > 0) {
      parts.push(`캐시 ${Math.round((Math.min(usage.cached, usage.input) / usage.input) * 100)}%`)
    }
    if (isCount(usage.durationMs) && usage.durationMs > 0) {
      const seconds = Math.max(1, Math.round(usage.durationMs / 1000))
      const minutes = Math.floor(seconds / 60)
      const rest = seconds % 60
      parts.push(minutes ? `${minutes}분${rest ? ` ${rest}초` : ''}` : `${seconds}초`)
    }
    for (const [period, label] of [['fiveHour', '5시간'], ['sevenDay', '주간']]) {
      const limit = usage.limits?.[period]
      if (!limit || ![limit.before, limit.after, limit.used].every(isCount)) continue
      const delta = limit.used > 0 ? `+${limit.used}%p` : ''
      const annotation = limit.reset === true ? (delta ? `초기화 후 ${delta}` : '초기화') : delta
      parts.push(`${label} ${limit.before}% → ${limit.after}%${annotation ? ` (${annotation})` : ''}`)
    }
    return parts.join(' · ')
  }

  function chatContent(item, expanded) {
    const text = typeof item.text === 'string' ? item.text : ''
    if (item.kind === 'user') {
      const message = el('div', 'remote-chat-outgoing')
      appendTimestamp(message, item.sentAt ?? item.time)
      message.append(el('div', 'remote-chat-user', text || (item.hasImage ? '이미지 첨부' : '')))
      return message
    }
    if (item.kind === 'assistant') {
      const message = el('div', 'remote-chat-incoming')
      const answer = el('div', 'remote-chat-answer')
      appendAnswer(answer, text)
      message.append(answer)
      appendTimestamp(message, item.time)
      return message
    }
    if (item.kind === 'notice') return el('p', 'remote-chat-notice', text)
    const tool = item.tool
    const label = item.kind === 'thinking' ? '생각' : item.kind === 'output' ? item.outputCommand || '출력'
      : item.kind === 'tool' && tool ? tool.name || '도구' : ''
    if (!label) return null
    const details = el('details', 'remote-chat-detail')
    details.open = expanded
    const summary = el('summary', 'remote-chat-tool-head')
    summary.append(el('span', 'remote-chat-tool-name', label))
    if (typeof tool?.summary === 'string' && tool.summary) {
      const description = el('span', 'remote-chat-tool-summary', tool.summary)
      description.title = tool.summary
      summary.append(description)
    }
    if (item.isError || tool?.isError) {
      details.dataset.error = 'true'
      summary.append(el('span', 'remote-chat-tool-failed', '실패'))
    }
    details.append(summary)
    const body = el('div', 'remote-chat-tool-body')
    const parts = tool ? [tool.input, tool.result, Array.isArray(tool.diff) ? tool.diff.join('\n') : ''] : [text]
    for (const part of parts) {
      if (typeof part === 'string' && part) body.append(el('pre', '', part))
    }
    if (body.firstElementChild) details.append(body)
    return details
  }

  ns.createAgents = function createAgents({ list, chat, send, onOpen, openReview, openServer }) {
    let watching = false
    let agents = null
    let reviewTabs = []
    let projectServers = []
    let selectedServer = null
    let selectedProject = null
    let listError = ''
    let current = null
    let armTimer = null
    const rows = new Map()
    const foldedProjects = new Set()

    chat.classList.add('remote-chat-view')
    const listBar = el('header', 'bar')
    const listHeading = el('strong', '', '로컬 작업')
    listBar.append(listHeading)
    const cards = el('div', 'list remote-agent-cards')
    list.replaceChildren(listBar, cards)

    const stop = button('중지', 'remote-chat-stop', interrupt)
    const meta = el('header', 'remote-chat-meta')
    const provider = el('span', 'remote-agent-kind')
    const status = el('span', 'remote-agent-status')
    status.setAttribute('role', 'status')
    const paneTitle = el('strong', 'remote-chat-pane-title')
    meta.append(provider, paneTitle, status)

    const scroll = el('div', 'list remote-chat-scroll')
    scroll.setAttribute('aria-label', '대화 내용')
    scroll.tabIndex = 0
    const older = button('이전 대화 더 보기', 'remote-chat-older', requestOlder)
    const empty = el('p', 'empty remote-chat-empty')
    const turns = el('div', 'remote-chat-turns')
    scroll.append(older, empty, turns)
    scroll.addEventListener('scroll', () => {
      if (scroll.scrollTop < 30 && scroll.scrollHeight > scroll.clientHeight) requestOlder()
    }, { passive: true })

    const approvalCard = el('section', 'remote-chat-approval')
    approvalCard.setAttribute('aria-label', '에이전트의 확인 요청')
    const form = el('form', 'remote-chat-form')
    const note = el('p', 'remote-chat-note')
    note.setAttribute('role', 'status')
    const progress = el('p', 'remote-chat-progress', '작업 중…')
    progress.setAttribute('role', 'status')
    const input = el('textarea', 'remote-chat-input')
    input.rows = 1
    input.maxLength = MAX_TEXT
    input.setAttribute('aria-label', '에이전트에게 보낼 글')
    input.placeholder = '에이전트에게 보낼 글'
    const submit = el('button', 'primary remote-chat-send')
    submit.type = 'submit'
    const sendIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    sendIcon.setAttribute('class', 'send-glyph')
    sendIcon.setAttribute('aria-hidden', 'true')
    sendIcon.setAttribute('viewBox', '0 0 24 24')
    const sendPath = document.createElementNS(sendIcon.namespaceURI, 'path')
    // Remix Icon RiSendPlane2Line, also used by AgentChatCover.
    sendPath.setAttribute('d', 'M3.5 1.34558C3.58425 1.34558 3.66714 1.36687 3.74096 1.40747L22.2034 11.5618C22.4454 11.6949 22.5337 11.9989 22.4006 12.2409C22.3549 12.324 22.2865 12.3924 22.2034 12.4381L3.74096 22.5924C3.499 22.7255 3.19497 22.6372 3.06189 22.3953C3.02129 22.3214 3 22.2386 3 22.1543V1.84558C3 1.56944 3.22386 1.34558 3.5 1.34558ZM5 4.38249V10.9999H10V12.9999H5V19.6174L18.8499 11.9999L5 4.38249Z')
    sendIcon.append(sendPath)
    submit.append(sendIcon)
    const composer = el('div', 'remote-chat-composer')
    composer.append(input, stop, submit)
    form.append(note, progress, composer)
    form.addEventListener('submit', sendChat)
    input.addEventListener('input', () => {
      setNote(draftError(input.value), true)
      renderControls()
    })
    const pane = el('div', 'remote-chat-pane')
    pane.append(meta, scroll, approvalCard, form)
    chat.replaceChildren(pane)
    document.addEventListener('visibilitychange', armApproval)

    function setNote(text, error = false) {
      note.textContent = text
      note.hidden = !text
      note.classList.toggle('is-error', error)
    }

    function renderList() {
      const focus = cards.contains(document.activeElement) ? document.activeElement.dataset : {}
      cards.replaceChildren()
      if (listError) {
        const message = el('p', 'error', listError)
        message.setAttribute('role', 'status')
        cards.append(message)
      }
      if (!agents?.length && !reviewTabs.length && !projectServers.length) {
        if (!listError) cards.append(el('p', 'empty', agents ? '실행 중인 에이전트가 없습니다.' : '에이전트 목록을 불러오는 중…'))
        return
      }
      const fragment = document.createDocumentFragment()
      let focusedButton = null
      for (const group of projectGroups(agents ?? [], reviewTabs, projectServers)) {
        const section = el('div', 'remote-agent-project')
        const heading = el('div', 'remote-agent-project-heading')
        const name = el('strong', 'remote-agent-project-name', group.name)
        name.title = group.name
        const children = el('div', 'remote-agent-project-children')
        let toggle = null
        if (group.tabs.length || group.servers.length) {
          const updateFold = () => {
            children.hidden = foldedProjects.has(group.id)
            toggle.setAttribute('aria-expanded', String(!children.hidden))
          }
          toggle = button('', 'remote-agent-project-title remote-agent-project-toggle', () => {
            if (foldedProjects.has(group.id)) foldedProjects.delete(group.id)
            else foldedProjects.add(group.id)
            updateFold()
          })
          toggle.dataset.projectId = group.id
          if (group.id === focus.projectId) focusedButton = toggle
          toggle.append(name)
          heading.append(toggle)
          updateFold()
        } else {
          const title = el('span', 'remote-agent-project-title')
          title.append(name)
          heading.append(title)
        }
        if (group.agents.length) {
          const chips = el('div', 'remote-agent-chips')
          chips.setAttribute('role', 'group')
          chips.setAttribute('aria-label', `${group.name} 에이전트`)
          for (const agent of group.agents) {
            const chip = agentChip(agent)
            if (agent.shellId === focus.agentShellId) focusedButton = chip
            chips.append(chip)
          }
          heading.append(chips)
        }
        section.append(heading)
        if (group.servers.length) {
          const servers = el('div', 'remote-project-servers')
          servers.setAttribute('role', 'group')
          servers.setAttribute('aria-label', `${group.name} 서버`)
          servers.append(el('div', 'remote-project-server-title', '서버'))
          for (const session of group.servers) {
            const row = button('', 'tree-session remote-project-server', () => openServer(session, { id: group.id, name: group.name }))
            row.dataset.projectServerId = session.id
            row.dataset.projectServerGroup = group.id
            row.title = session.name
            const icon = el('span', 'terminal-glyph', '>_')
            icon.setAttribute('aria-hidden', 'true')
            row.append(icon, el('span', 'tree-name', session.name))
            if (session.id === focus.projectServerId && group.id === focus.projectServerGroup) focusedButton = children.hidden ? toggle : row
            servers.append(row)
          }
          children.append(servers)
        }
        for (const tab of group.tabs) {
          const row = button('', 'tree-session remote-agent-review', () => openReview(tab))
          row.dataset.reviewTabId = tab.id
          row.title = `${tab.name} · 브라우저 검토`
          const icon = el('span', 'terminal-glyph', '▤')
          icon.setAttribute('aria-hidden', 'true')
          row.append(icon, el('span', 'tree-name', tab.name))
          row.setAttribute('aria-label', row.title)
          if (tab.id === focus.reviewTabId) focusedButton = children.hidden ? toggle : row
          children.append(row)
        }
        if (group.tabs.length || group.servers.length) section.append(children)
        fragment.append(section)
      }
      cards.append(fragment)
      updateSelection()
      focusedButton?.focus({ preventScroll: true })
    }

    function agentChip(agent) {
      const chip = button('', 'remote-agent-chip', () => onOpen(agent))
      const state = statusOf(agent)
      chip.dataset.agentShellId = agent.shellId
      chip.dataset.agentWork = state === 'working' ? 'working' : 'idle'
      chip.dataset.status = state
      chip.dataset.kind = agent.kind
      chip.title = `${nameOf(agent)} · ${STATUSES[state]}`
      chip.setAttribute('aria-label', chip.title)
      const provider = Object.hasOwn(PROVIDERS, agent.kind) ? agent.kind : 'unknown'
      chip.append(
        chipIcon('remote-agent-chip-provider', AGENT_ICON_PATHS[provider]),
        chipIcon('remote-agent-chip-status', AGENT_ICON_PATHS[state])
      )
      return chip
    }

    function updateSelection() {
      for (const chip of cards.querySelectorAll('[data-agent-shell-id]')) {
        if (chip.dataset.agentShellId === current?.agent.shellId) chip.setAttribute('aria-current', 'true')
        else chip.removeAttribute('aria-current')
      }
      for (const row of cards.querySelectorAll('[data-project-server-id]')) {
        if (row.dataset.projectServerId === selectedServer && row.dataset.projectServerGroup === selectedProject) row.setAttribute('aria-current', 'true')
        else row.removeAttribute('aria-current')
      }
    }

    function openChat(agent, draft = '') {
      if (!watching || (current?.agent.shellId === agent.shellId && !current.closed)) return
      if (current) closeChat()
      current = { agent, connected: false, state: 'opening', title: null, hasOlder: false }
      input.value = draft
      updateSelection()
      renderControls()
      send({ type: 'chat-open', shellId: agent.shellId })
    }

    function closeChat(notify = true) {
      if (current && !current.closed && notify) send({ type: 'chat-close', shellId: current.agent.shellId })
      current = null
      updateSelection()
      clearRows()
      input.value = ''
      setNote('')
      renderApproval()
      renderControls()
    }

    function renderControls() {
      const active = current
      const state = active?.state
      const statusName = state === 'ended' ? 'ended' : active?.approval ? 'blocked' : active ? statusOf(active.agent) : 'unknown'
      paneTitle.textContent = active ? active.title || nameOf(active.agent) : ''
      provider.textContent = active ? providerOf(active.agent) : ''
      provider.dataset.kind = active?.agent.kind || ''
      setStatus(status, statusName)
      status.hidden = statusName === 'idle' || statusName === 'working'
      pane.dataset.agentWork = statusName === 'working' ? 'working' : 'idle'
      progress.hidden = !active?.connected || statusName !== 'working'
      const progressText = active?.interrupting ? '중지하는 중…' : '작업 중…'
      if (progress.textContent !== progressText) progress.textContent = progressText
      stop.hidden = !active?.connected || active.agent.kind === 'antigravity' || statusName !== 'working'
      stop.disabled = Boolean(active?.interrupting)
      stop.textContent = stop.disabled ? '중지 중…' : '중지'
      older.hidden = !active?.connected || !active.hasOlder || rows.size >= MAX_ITEMS
      older.disabled = Boolean(active?.loadingOlder)
      older.textContent = older.disabled ? '불러오는 중…' : '이전 대화 더 보기'
      empty.hidden = rows.size > 0
      empty.textContent = state === 'opening' ? '대화를 여는 중…' : state === 'ended' ? '대화가 종료되었습니다.' : '아직 대화가 없습니다.'
      input.readOnly = !active?.connected || state === 'ended' || Boolean(active.sending)
      const canSend = statusName === 'idle' || (statusName === 'working' && active.agent.kind !== 'antigravity')
      submit.disabled = input.readOnly || !canSend || !input.value.trim() || Boolean(draftError(input.value))
      submit.setAttribute('aria-label', active?.sending ? '전송 중…' : '보내기')
    }

    function draftError(text) {
      const first = text.trimStart()[0]
      if (first === '/' || first === '!') return '휴대폰에서는 슬래시 명령과 !로 시작하는 셸 입력을 보낼 수 없습니다.'
      return ''
    }

    function sendChat(event) {
      event.preventDefault()
      const text = input.value.replace(/^\n+/, '').trimEnd()
      const error = draftError(text)
      if (error) return setNote(error, true)
      if (!text.trim() || text.length > MAX_TEXT || submit.disabled) return
      const requestId = String(++nextRequest)
      current.sending = requestId
      setNote('')
      renderControls()
      send({ type: 'chat-send', shellId: current.agent.shellId, requestId, text })
    }

    function interrupt() {
      if (stop.hidden || stop.disabled) return
      current.interrupting = true
      renderControls()
      send({ type: 'chat-interrupt', shellId: current.agent.shellId })
    }

    function requestOlder() {
      if (older.hidden || older.disabled) return
      current.loadingOlder = true
      renderControls()
      send({ type: 'chat-older', shellId: current.agent.shellId })
    }

    function clearRows() {
      rows.clear()
      turns.replaceChildren()
    }

    function setUsageLine(row, text) {
      const label = row.lastElementChild
      if (label?.className === 'remote-chat-usage') {
        if (!text) label.remove()
        else if (label.textContent !== text) label.textContent = text
      } else if (text) row.append(el('p', 'remote-chat-usage', text))
    }

    function updateTurnUsage() {
      // Older pages are prepended. Walk the visible order rather than the Map's insertion order.
      let previous = null
      let usage = ''
      for (const row of turns.children) {
        const entry = rows.get(row.dataset.id)
        if (previous) setUsageLine(previous, entry.startsTurn ? usage : '')
        if (entry.startsTurn) usage = entry.usage
        previous = row
      }
      if (previous) setUsageLine(previous, usage)
    }

    function updateRows(frame) {
      const atBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 60
      const before = scroll.scrollHeight
      const top = scroll.scrollTop
      if (frame.reset) clearRows()
      const items = Array.isArray(frame.items) ? frame.items : []
      const fresh = new Map()
      for (const item of items) {
        if (typeof item?.id !== 'string') continue
        const old = rows.get(item.id)
        const content = chatContent(item, old?.row.querySelector('details')?.open === true)
        if (!content) continue
        const row = el('div', 'remote-chat-row')
        row.dataset.id = item.id
        row.append(content)
        const startsTurn = item.kind === 'user'
        const entry = { row, startsTurn, usage: startsTurn ? turnUsageText(item.usage) : '' }
        if (old) {
          old.row.replaceWith(row)
          rows.set(item.id, entry)
        } else fresh.set(item.id, entry)
      }
      const available = frame.older ? MAX_ITEMS - rows.size : MAX_ITEMS
      const fragment = document.createDocumentFragment()
      for (const [id, entry] of [...fresh].slice(fresh.size - Math.min(available, fresh.size))) {
        rows.set(id, entry)
        fragment.append(entry.row)
      }
      if (frame.older) turns.prepend(fragment)
      else turns.append(fragment)
      while (rows.size > MAX_ITEMS) {
        const first = turns.firstElementChild
        rows.delete(first.dataset.id)
        first.remove()
      }
      updateTurnUsage()
      renderControls()
      if (frame.older) scroll.scrollTop = top + scroll.scrollHeight - before
      else if (frame.reset || atBottom) scroll.scrollTop = scroll.scrollHeight
    }

    function armApproval() {
      clearTimeout(armTimer)
      armTimer = null
      const active = current
      if (!active) return
      const buttons = [...approvalCard.querySelectorAll('button')]
      buttons.forEach(node => { node.disabled = true })
      active.armAt = Infinity
      const signature = active.approval?.signature
      if (!buttons.length || document.hidden || chat.hidden) return
      active.armAt = performance.now() + ARM_MS
      armTimer = setTimeout(() => {
        if (current === active && active.approval?.signature === signature) updateApprovalButtons()
      }, ARM_MS)
    }

    function updateApprovalButtons() {
      const active = current
      const enabled = active?.connected && !active.answering && active.answered !== active.approval?.signature
        && !document.hidden && !chat.hidden && performance.now() >= active.armAt
      for (const node of approvalCard.querySelectorAll('button')) node.disabled = !enabled || node.dataset.phoneBlocked === 'true'
    }

    function renderApproval() {
      const request = current?.approval
      approvalCard.replaceChildren()
      approvalCard.hidden = !request
      if (request) {
        approvalCard.append(el('strong', 'remote-chat-approval-question', request.question || '에이전트가 확인을 기다리고 있습니다.'))
        if (Array.isArray(request.detail) && request.detail.length) {
          approvalCard.append(el('pre', 'remote-chat-approval-detail', request.detail.join('\n')))
        }
        const options = Array.isArray(request.options) ? request.options.filter(option => /^[1-9]$/.test(option?.key)) : []
        if (current.agent.kind === 'antigravity' || request.usesTerminalInput || request.terminalOnly || !options.length || typeof request.signature !== 'string') {
          approvalCard.append(el('p', 'remote-chat-note', '이 확인 요청은 PC의 터미널에서 응답해 주세요.'))
        } else {
          const choices = el('div', 'remote-chat-choices')
          for (const option of options) {
            const phoneBlocked = option.phoneBlocked === true
            const choice = button('', 'remote-chat-approval-option', () => {
              if (!phoneBlocked) answer(option.key, request.signature)
            })
            choice.append(el('span', 'remote-chat-approval-key', option.key), el('span', 'remote-chat-approval-label', option.label))
            if (phoneBlocked) {
              choice.dataset.phoneBlocked = 'true'
              choice.append(el('span', 'remote-chat-approval-pc-only', 'PC에서만'))
            }
            choices.append(choice)
          }
          approvalCard.append(choices)
        }
      }
      armApproval()
    }

    function answer(key, signature) {
      if (!current?.connected || current.approval?.signature !== signature || current.answering || current.answered === signature
        || document.hidden || chat.hidden || performance.now() < current.armAt) return
      current.answering = signature
      updateApprovalButtons()
      send({ type: 'chat-answer', shellId: current.agent.shellId, key, signature })
    }

    function endChat(message, notify = true) {
      if (!current.closed && notify) send({ type: 'chat-close', shellId: current.agent.shellId })
      Object.assign(current, { closed: true, connected: false, state: 'ended', approval: null, sending: null })
      renderApproval()
      setNote(message, true)
      renderControls()
    }

    function frame(msg) {
      if (msg.gone) return endChat('PC에서 에이전트 세션이 닫혔습니다.')
      if (msg.kind && msg.kind !== current.agent.kind) return endChat(AGENT_CHANGED)
      if (msg.title !== undefined) current.title = msg.title
      if (msg.hasOlder !== undefined) current.hasOlder = msg.hasOlder
      if (msg.approval !== undefined && (Boolean(msg.approval) !== Boolean(current.approval)
        || msg.approval?.signature !== current.approval?.signature)) {
        current.approval = msg.approval
        current.answered = null
        renderApproval()
      }
      if (msg.state !== undefined) current.state = msg.state
      if (msg.state === 'ended') endChat('에이전트가 종료되었습니다.')
      if (msg.items || msg.reset) updateRows(msg)
      else renderControls()
    }

    function requestList() {
      send({ type: 'agents-list' })
      send({ type: 'agents-watch', on: true })
    }

    function showListError(message) {
      listError = message
      agents = []
      renderList()
      if (current) {
        clearRows()
        input.value = ''
        endChat(message, false)
      }
    }

    function onMessage(msg) {
      if (msg.type === 'features') {
        if (!watching) return
        if (msg.features?.agents === false && !listError) showListError(ACCESS_OFF)
        if (msg.features?.agents === true && listError) {
          listError = ''
          agents = null
          renderList()
          requestList()
        }
        return
      }
      if (msg.type === 'agents') {
        if (!watching) return
        if (typeof msg.error === 'string' && msg.error) return showListError(msg.error)
        listError = ''
        agents = Array.isArray(msg.agents) ? msg.agents.filter(agent => typeof agent?.shellId === 'string') : []
        renderList()
        if (current && !current.closed) {
          const active = agents.find(agent => agent.shellId === current.agent.shellId
            && agent.agentId === current.agent.agentId && agent.kind === current.agent.kind)
          if (!active) return endChat(AGENT_CHANGED)
          current.agent = active
          renderControls()
        }
        return
      }
      if (!current || current.closed || msg.shellId !== current.agent.shellId) return
      switch (msg.type) {
        case 'chat-frame':
          return frame(msg)
        case 'chat-opened':
          if (!msg.ok) return endChat(msg.error || '대화를 열지 못했습니다.')
          current.connected = true
          if (current.state === 'opening') current.state = 'waiting'
          updateApprovalButtons()
          break
        case 'chat-older-result':
          current.loadingOlder = false
          if (!msg.ok) setNote(msg.error || '이전 대화를 불러오지 못했습니다.', true)
          break
        case 'chat-send-result':
          if (!current.sending || current.sending !== msg.requestId) return
          if (msg.ok) input.value = ''
          current.sending = null
          setNote(msg.ok ? '보냈습니다.' : msg.error || '메시지를 보내지 못했습니다.', !msg.ok)
          break
        case 'chat-answer-result': {
          const signature = current.answering
          current.answering = null
          if (signature && signature === current.approval?.signature) {
            if (msg.ok) current.answered = signature
            setNote(msg.ok ? '응답을 보냈습니다.' : msg.error || '응답을 보내지 못했습니다.', !msg.ok)
          }
          updateApprovalButtons()
          break
        }
        case 'chat-interrupt-result':
          current.interrupting = false
          setNote(msg.ok ? '중지를 요청했습니다.' : msg.error || '중지하지 못했습니다.', !msg.ok)
          break
      }
      renderControls()
    }

    function reset(notify = false, keepReviews = false) {
      watching = false
      agents = null
      if (!keepReviews) {
        reviewTabs = []
        projectServers = []
        selectedServer = null
        selectedProject = null
      }
      listError = ''
      cards.replaceChildren()
      closeChat(notify)
      if (reviewTabs.length || projectServers.length) renderList()
    }

    closeChat(false)
    return {
      get isOpen() { return Boolean(current && !current.closed) },
      get draft() { return current?.sending ? '' : input.value },
      get hasReviewTabs() { return reviewTabs.length > 0 },
      nameOf,
      setTabStatus(dot, agent, unavailable) {
        const status = unavailable ? 'ended' : statusOf(agent)
        dot.dataset.status = status
        dot.setAttribute('role', 'img')
        dot.setAttribute('aria-label', STATUSES[status])
        dot.title = STATUSES[status]
      },
      setReviewTabs(tabs) {
        reviewTabs = Array.isArray(tabs) ? tabs.filter(tab => tab?.kind === 'browser' && typeof tab.id === 'string') : []
        renderList()
      },
      setProjectServers(projects) {
        projectServers = projects
        renderList()
      },
      selectServer(id, project) {
        selectedServer = id
        selectedProject = project
        updateSelection()
      },
      reopen: openChat,
      enter() {
        if (watching) return
        watching = true
        renderList()
        requestList()
      },
      leave() {
        if (!watching) return
        send({ type: 'agents-watch', on: false })
        reset(true, true)
      },
      closeChat,
      reset,
      onMessage
    }
  }
})()
