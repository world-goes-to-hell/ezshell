const fs = require('node:fs')
const path = require('node:path')
const { connect, createChecks, openLocalAgent, sleep, unlock } = require('../support/driver')

const { check, finish } = createChecks()

async function run() {
  if (process.env.E2E_APP || process.platform !== 'win32') {
    console.log('SKIP local agent fixture needs the Windows development build')
    return
  }
  const profile = process.env.E2E_PROFILE
  const file = name => path.join(profile, name)
  const read = name => fs.existsSync(file(name)) ? fs.readFileSync(file(name), 'utf8') : ''
  const driver = await connect()
    const { js, send, until, center, click, enter, shot } = driver
  try {
    await unlock(driver)
    await send('Page.bringToFront')
    await send('Emulation.setFocusEmulationEnabled', { enabled: true })
    const largeImage = await js(`(() => {
      const canvas = document.createElement('canvas')
      canvas.width = 960
      canvas.height = 480
      const context = canvas.getContext('2d')
      context.fillStyle = '#2f68b0'
      context.fillRect(0, 0, canvas.width, canvas.height)
      context.fillStyle = '#fff'
      context.font = '32px sans-serif'
      context.fillText('ezShell 이미지 미리보기', 32, 52)
      return canvas.toDataURL('image/png').split(',')[1]
    })()`)
    fs.writeFileSync(file('attachment-2.png'), Buffer.from(largeImage, 'base64'))
    const press = async key => {
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...key })
    }
    const activePane = `[...document.querySelectorAll('.local-terminal-tab')].find(tab =>
      getComputedStyle(tab).visibility === 'visible')?.querySelector('.local-terminal-pane')`
    const cover = `${activePane}?.querySelector('.agent-chat-cover')`
    const input = `${cover}?.querySelector('.agent-chat-input')`
    const widths = selector => `[...${cover}.querySelectorAll(${JSON.stringify(selector)})].map(img => img.naturalWidth).join(',')`
    const setDraft = (text, index = text.length) => js(`(() => {
      const input = ${input}
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(text)})
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.focus()
      input.setSelectionRange(${index}, ${index})
    })()`)
    const paste = () => press({ key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, modifiers: 2 })
    const append = (transcript, entry) => fs.appendFileSync(transcript, JSON.stringify({
      timestamp: new Date().toISOString(), ...entry
    }) + '\n')
    const working = `${cover}.querySelector('.agent-chat-status')?.dataset.status === 'working'`

    for (const kind of ['claude', 'codex']) {
      await openLocalAgent(driver, kind, profile)
      const agentId = `window.electronAPI.agentMessagesSnapshot().then(snapshot =>
        snapshot.agents.find(agent => agent.kind === ${JSON.stringify(kind)} && agent.active)?.id)`
      await until(agentId)
      const agent = await js(agentId)
      if (!agent || !await until(`${activePane}?.textContent.includes(${JSON.stringify('fixture ready: ' + agent)})`)) {
        throw new Error(`The ${kind} fixture did not open`)
      }
      await js(`${activePane}.querySelector('.xterm-helper-textarea').focus()`)
      await press({ key: 'F11', code: 'F11', windowsVirtualKeyCode: 122, modifiers: 10 })
      if (!await until(`!!${input}`)) throw new Error(`The ${kind} composer did not open`)
      const sessionId = '5a6f0d9e-1b2c-4d3e-8f90-0a1b2c3d4e5f'
      const transcript = file(path.join('claude-home', 'projects', 'test', sessionId + '.jsonl'))
      const answer = (id, text) => append(transcript, {
        type: 'assistant', uuid: id, message: { id, role: 'assistant', content: [{ type: 'text', text }] }
      })
      if (kind === 'claude') {
        answer('prior-answer', '앞 작업을 진행합니다')
        const report = file('claude-status.json')
        fs.writeFileSync(report, JSON.stringify({ session_id: sessionId, model: { id: 'claude-opus-5-5' } }))
        fs.writeFileSync(file(agent + '-command'), `"%EZSHELL_TEST_AGENT_EXE%" "%EZSHELL_AGENT_USAGE_SCRIPT%" < "${report}"`)
        if (!await until(`${cover}.textContent.includes('앞 작업을 진행합니다')`, 8000)) {
          throw new Error('The chat did not attach to the Claude transcript')
        }
        fs.writeFileSync(file(agent + '-program-status'), 'state=working:app=claude')
        if (!await until(working)) throw new Error('The Claude fixture did not start working')
      }
      await setDraft('앞뒤', 1)
      fs.writeFileSync(file('clipboard-comment'), '캡처 설명')
      await paste()
      const captured = '앞 [첨부이미지 1]\n캡처 설명 뒤'
      check(`${kind} adds the clipboard image and its comment at the caret`, await until(`
        ${input}.value === ${JSON.stringify(captured)} && ${widths('.agent-chat-attachment img')} === '1'
      `))
      fs.unlinkSync(file('clipboard-comment'))
      await js(`${input}.setSelectionRange(${input}.value.length, ${input}.value.length)`)
      await click(...await center(`${cover}.querySelector('.agent-chat-add-image')`))
      check(`${kind} numbers both files selected together`, await until(`
        ${input}.value.trim().endsWith('[첨부이미지 2] [첨부이미지 3]') && ${widths('.agent-chat-attachment img')} === '1,280,3'
      `))

      const before = '[첨부이미지 2] 이 사진의 버튼을 누르니까 '
      const after = ' 이렇게 됐어'
      await setDraft(before + after, before.length)
      check(`${kind} excludes images whose references were deleted`, await until(`${widths('.agent-chat-attachment img')} === '280'`))
      fs.writeFileSync(file('clipboard-text'), '[첨부이미지 1]')
      await paste()
      check(`${kind} restores a moved reference to the original image`, await until(`
        ${input}.value === ${JSON.stringify(before + '[첨부이미지 1]' + after)}
        && ${widths('.agent-chat-attachment img')} === '280,1'
      `))
      fs.unlinkSync(file('clipboard-text'))
      await click(...await center(`${cover}.querySelector('.agent-chat-send')`))
      for (let i = 0; i < 100 && read(agent + '-chat-sent') !== '1'; i++) await sleep(100)
      const submitted = read(agent + '-chat-text')
      const paths = kind === 'claude' ? submitted.split('\n\n')[0].split('\n') : JSON.parse(read(agent + '-chat-images') || '[]')
      const body = kind === 'claude' ? submitted.split('\n\n').slice(1).join('\n\n') : submitted
      const expected = '[첨부이미지 1] 이 사진의 버튼을 누르니까 [첨부이미지 2] 이렇게 됐어'
      check(`${kind} receives the text in order and image 1 points to the first actual attachment`, read(agent + '-chat-sent') === '1'
        && body === expected && paths.length === 2 && paths.every((image, index) =>
          fs.existsSync(image) && fs.readFileSync(image).readUInt32BE(16) === (index === 0 ? 960 : 1)), JSON.stringify({ body, paths: paths.length }))
      check(`${kind} shows the numbered images above the same sent message`, await until(`
        ${cover}.querySelector('.agent-chat-user .agent-chat-bubble')?.textContent === ${JSON.stringify(expected)}
        && ${widths('.agent-chat-sent-images img')} === '280,1' && !${input}.value
      `))
      const thumbnail = `${cover}.querySelector('.agent-chat-sent-image')`
      const viewer = `document.querySelector('.agent-chat-image-preview[role="dialog"]')`
      const enlarged = `${viewer}?.querySelector('img')`
      const escape = { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }
      await click(...await center(thumbnail))
      check(`${kind} opens the full resolution attachment in a larger dialog`, await until(`
        ${viewer}?.querySelector('h2')?.textContent === '[첨부이미지 1]' &&
        ${enlarged}?.naturalWidth === 960 && ${enlarged}.naturalHeight === 480 &&
        ${enlarged}.clientWidth > ${thumbnail}.clientWidth * 2 && getComputedStyle(${enlarged}).objectFit === 'contain'
      `, 6000))
      if (kind === 'claude') {
        await shot('local-agent-chat-image-preview')
        await press(escape)
      } else await click(8, 110)
      check(`${kind} dismisses the dialog and restores focus to the attachment`, await until(`!${viewer} && document.activeElement === ${thumbnail}`))
      if (kind === 'claude') {
        check('Escape does not interrupt Claude while dismissing the image', !read(agent + '-chat-interrupt'))
        const nativePrompt = '[Image #7] [Image #8]' + expected
        const waiting = `${cover}.querySelector('.agent-chat-user .agent-chat-waiting')`
        check('an image message sent to a working Claude shows as waiting', await until(`!!${waiting} && ${working}`))
        append(transcript, { type: 'queue-operation', operation: 'enqueue', content: nativePrompt })
        answer('prior-progress', '앞 작업을 계속 진행합니다')
        check('Claude recording the queue entry leaves the image message waiting', await until(`
          ${cover}.textContent.includes('앞 작업을 계속 진행합니다') && !!${waiting} && ${working}
        `))
        append(transcript, {
          type: 'attachment', uuid: 'read-images', attachment: {
            type: 'queued_command', commandMode: 'prompt', origin: { kind: 'human' }, humanTurn: true, imagePasteIds: [7, 8],
            prompt: [{ type: 'text', text: nativePrompt }, ...paths.map(image => ({
              type: 'image', source: { type: 'base64', media_type: 'image/png', data: fs.readFileSync(image, 'base64') }
            }))]
          }
        })
        check('Claude reading the image message clears the wait mark and keeps both previews on one bubble', await until(`
          !!${cover}.querySelector('[data-chat-row="item:user:read-images"]')
          && ${cover}.querySelectorAll('.agent-chat-user').length === 1
          && ${cover}.querySelector('.agent-chat-user .agent-chat-bubble')?.textContent === ${JSON.stringify(expected)}
          && ${widths('.agent-chat-sent-images img')} === '280,1' && !${waiting} && ${working}
        `, 8000), await js(`${cover}.textContent`))
        await js(`${thumbnail}.focus()`)
        await enter()
        check('the attachment still opens with the keyboard after the transcript replaces the optimistic message',
          await until(`${enlarged}?.naturalWidth === 960`))
        await press(escape)
        await until(`!${viewer}`)
      }
      await setDraft('')
      await paste()
      if (!await until(`${input}.value.trim() === '[첨부이미지 1]' && ${widths('.agent-chat-attachment img')} === '1'`)) {
        throw new Error(`The ${kind} image-only draft did not open`)
      }
      await click(...await center(`${cover}.querySelector('.agent-chat-attachment button')`))
      check(`${kind} removing the preview also removes the reference`, await until(`
        !${input}.value && !${widths('.agent-chat-attachment img')} && ${cover}.querySelector('.agent-chat-send').disabled
      `))
      if (kind === 'claude') {
        const terminalDraft = 'Claude input left in the terminal'
        const forcedText = '채팅에서 강제로 보내는 메시지'
        fs.writeFileSync(file(agent + '-draft'), terminalDraft)
        await setDraft(forcedText)
        await sleep(350)
        await click(...await center(`${cover}.querySelector('.agent-chat-send')`))
        const forceButton = `${cover}.querySelector('.agent-chat-force-send button')`
        const offered = await until(`!!${forceButton} && ${input}.value === ${JSON.stringify(forcedText)}`)
        check('Claude offers force send while preserving both drafts after a normal rejection', offered
          && !read(agent + '-forced-clear') && read(agent + '-chat-sent') === '1')
        if (offered) {
          await click(...await center(forceButton))
          for (let i = 0; i < 80 && read(agent + '-chat-sent') !== '2'; i++) await sleep(75)
          check('the force button clears the Claude editor and sends only the new chat draft',
            read(agent + '-forced-clear') === 'x' && read(agent + '-chat-sent') === '2' && read(agent + '-chat-text') === forcedText
            && await until(`!${forceButton} && !${input}.value`))
        }
      }
    }
  } finally { driver.close() }
}

run().then(finish).catch(error => { console.error(error); process.exit(1) })
