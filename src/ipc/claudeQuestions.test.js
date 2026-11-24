import { describe, expect, it } from 'vitest'
import { createClaudeQuestionAnswerer, readQuestionScreen, readReview } from './claudeQuestions.js'
import { createFakeAskDialog } from '../../e2e/support/fakeAskDialog.js'

// The fake dialog behaves as the real CLI was seen to (shared with the fake agent of local-agent-chat)
const fakeDialog = createFakeAskDialog

const fruits = { question: 'Which fruits do you like?', header: 'Fruits', multiSelect: true, options: [{ label: 'Apple', description: 'red' }, { label: 'Banana', description: 'yellow' }, { label: 'Cherry', description: 'small' }] }
const color = { question: 'Which color?', header: 'Color', multiSelect: false, options: [{ label: 'Red', description: 'warm' }, { label: 'Green', description: 'calm' }, { label: 'Blue', description: 'cool' }] }

function answererFor(dialog, extra = {}) {
  const held = []
  const answerer = createClaudeQuestionAnswerer({ lines: dialog.lines, write: dialog.write, hold: on => held.push(on), pollMs: 1, quietMs: 2, releaseMs: 0, stepTimeout: 200, ...extra })
  return { answerer, held }
}

describe('reading the AskUserQuestion screen', () => {
  it('reads the question below the tab strip, its choices, boxes and the selection, not the numbered lines above', () => {
    const dialog = fakeDialog([fruits, color])
    const screen = readQuestionScreen(dialog.lines())
    expect(screen.question).toBe('Whichfruitsdoyoulike?')
    expect(screen.options.map(option => [option.number, option.checked, option.text])).toEqual([
      [1, false, 'Apple'], [2, false, 'Banana'], [3, false, 'Cherry'], [4, false, 'Type something'], [5, null, 'Chat about this']
    ])
    expect(screen.pointer).toBe(1)
  })

  it('reads the review: each question with its answers, and whether Submit is selected', () => {
    const review = readReview(['Review your answers', ' ● Which fruits', '   do you like?', '   → Apple,', '     Cherry', ' ● Which color?', '   → Green', '❯ 1. Submit answers', '  2. Cancel'])
    expect(review).toEqual({ entries: [{ question: 'Whichfruitsdoyoulike?', answer: 'Apple,Cherry' }, { question: 'Whichcolor?', answer: 'Green' }], unanswered: false, ready: true })
    expect(readQuestionScreen(['● 1. 대화', 'Enter to select · Esc to cancel'])).toBeNull()
  })
})

describe('answering the AskUserQuestion screen', () => {
  it('answers the only single choice question with its number', async () => {
    const dialog = fakeDialog([color])
    const { answerer, held } = answererFor(dialog)
    expect(await answerer.answer([color], [{ picks: [1], other: null }])).toEqual({ ok: true })
    expect(dialog.state.submitted).toEqual(['Green'])
    expect(dialog.state.keys).toEqual(['2'])
    expect(held).toEqual([true, false])
  })

  it('picks a choice beside previews with its number, then Enter (the number only moves the selection there)', async () => {
    const photo = { question: '어떤 사진을 쓸까요?', header: '사진', multiSelect: false, preview: true, options: [
      { label: '기존 아이콘으로 유형 카드 (Recommended)', description: '', preview: '+------+\n| icon |\n+------+' },
      { label: '이미지 파일 받기', description: '', preview: 'upload' }, { label: '종 사진 우선', description: '', preview: 'photo' }
    ] }
    const screen = readQuestionScreen(fakeDialog([photo]).lines())
    expect(screen).toMatchObject({ question: '어떤사진을쓸까요?', pointer: 1, preview: true })
    expect(screen.options.map(option => option.text + (option.more ?? ''))).toEqual(['기존 아이콘으로 유형 카드(Recommended)', '이미지 파일 받기', '종 사진 우선'])

    const dialog = fakeDialog([photo])
    const { answerer } = answererFor(dialog)
    expect(await answerer.answer([photo], [{ picks: [2], other: null }])).toEqual({ ok: true })
    expect(dialog.state.keys).toEqual(['3', '\r'])
    expect(dialog.state.submitted).toEqual(['종 사진 우선'])
  })

  it('toggles a checklist, types its own answer, moves on and submits once the review matches', async () => {
    const dialog = fakeDialog([fruits, color])
    const { answerer } = answererFor(dialog)
    const result = await answerer.answer([fruits, color], [{ picks: [0, 2], other: '빨간사과' }, { picks: [], other: '보라' }])
    expect(result).toEqual({ ok: true })
    expect(dialog.state.submitted).toEqual(['Apple, Cherry, 빨간사과', '보라'])
  })

  it('unchecks what was already checked and leaves the rest', async () => {
    const dialog = fakeDialog([fruits])
    dialog.write('2')
    const { answerer } = answererFor(dialog)
    expect(await answerer.answer([fruits], [{ picks: [0], other: null }])).toEqual({ ok: true })
    expect(dialog.state.submitted).toEqual(['Apple'])
  })

  it('does not submit when the review shows other answers', async () => {
    const dialog = fakeDialog([fruits, color], { reviewAs: [null, 'Blue'] })
    const { answerer } = answererFor(dialog)
    expect(await answerer.answer([fruits, color], [{ picks: [1], other: null }, { picks: [1], other: null }])).toEqual({ ok: false, reason: 'mismatch' })
    expect(dialog.state.submitted).toBeNull()
    expect(dialog.state.keys).not.toContain('1')
  })

  it('reports failure if the final review scrolls out of view before it can be verified', async () => {
    const questions = [color, { ...fruits, multiSelect: false }]
    const dialog = fakeDialog(questions)
    const cropped = {
      ...dialog,
      lines: () => dialog.state.tab === 'review' ? dialog.lines().slice(-2) : dialog.lines()
    }
    const { answerer, held } = answererFor(cropped)
    const result = await answerer.answer(questions, [{ picks: [1], other: null }, { picks: [2], other: null }])

    expect(result).toEqual({ ok: false, reason: 'stuck' })
    expect(dialog.state.tab).toBe('review')
    expect(dialog.state.keys).toEqual(['2', '3'])
    expect(dialog.state.submitted).toBeNull()
    expect(held).toEqual([true, false])
  })

  it('presses nothing when the screen shows another question', async () => {
    const dialog = fakeDialog([color])
    const { answerer } = answererFor(dialog)
    expect(await answerer.answer([{ ...color, question: 'Which shape?' }], [{ picks: [0], other: null }])).toEqual({ ok: false, reason: 'changed' })
    expect(dialog.state.keys).toEqual([])
  })

  it('stops when a key does not do what it should', async () => {
    const dialog = fakeDialog([fruits])
    const stuck = { ...dialog, write: data => (/^[1-9]$/.test(data) ? true : dialog.write(data)) }
    const { answerer, held } = answererFor(stuck)
    expect(await answerer.answer([fruits], [{ picks: [1], other: null }])).toEqual({ ok: false, reason: 'stuck' })
    expect(dialog.state.submitted).toBeNull()
    expect(held).toEqual([true, false])
  })

  it('runs one answer at a time', async () => {
    const dialog = fakeDialog([color])
    const { answerer } = answererFor(dialog)
    const first = answerer.answer([color], [{ picks: [0], other: null }])
    expect(await answerer.answer([color], [{ picks: [1], other: null }])).toEqual({ ok: false, reason: 'busy' })
    expect(await first).toEqual({ ok: true })
  })
})

describe('a narrow pane', () => {
  it('reads the dialog when its hint folds over two rows (real Claude at 48 columns)', () => {
    const rows = ['─'.repeat(48), '←  ☐ 과일  ☐ 색  ✔ Submit  →', '', '어떤 과일을 넣을까요?', '', '❯ 1. [ ] Apple', '         red',
      '  2. [ ] Banana', '  3. [ ] Cherry', '  4. [ ] Type something', '     Next', '─'.repeat(48), '  5. Chat about this', '',
      'Enter to select · Tab/Arrow keys to navigate · ', 'Esc to cancel']
    const screen = readQuestionScreen(rows)
    expect(screen.question).toBe('어떤과일을넣을까요?')
    expect(screen.options.map(option => option.number)).toEqual([1, 2, 3, 4, 5])
  })

  it('reads the hint folded anywhere, also right after "Esc"', () => {
    const rows = ['←  ☐ 과일  ✔ Submit  →', '', 'Q?', '', '❯ 1. [ ] Apple', '  2. [ ] Type something',
      'Enter to select · Tab/Arrow keys to navigate · ctrl+g to edit in Notepad · Esc ', 'to cancel']
    expect(readQuestionScreen(rows)?.question).toBe('Q?')
  })
})

describe('a low pane', () => {
  it('keeps answering once the question scrolls off, by the labels of its choices', async () => {
    const dialog = createFakeAskDialog([fruits, color])
    // As a low pane does when the selection goes down: the strip and the question leave the screen
    const low = { ...dialog, lines: () => { const all = dialog.lines(); return dialog.state.tab === 0 && dialog.state.keys.length ? all.slice(all.findIndex(row => /^\S*\s*1\. /.test(row) && row.includes('Apple'))) : all } }
    const { answerer } = answererFor(low)
    expect(await answerer.answer([fruits, color], [{ picks: [0], other: '키위' }, { picks: [1], other: null }])).toEqual({ ok: true })
    expect(dialog.state.submitted).toEqual(['Apple, 키위', 'Green'])
  })

  it('does not take a scrolled list with other labels for the question', () => {
    const screen = readQuestionScreen(['  1. 대화 속 목록', '❯ 1. [ ] Pear', '  2. [ ] Plum', 'Enter to select · Esc to cancel'])
    expect(screen.question).toBeNull()
    expect(screen.options.map(option => option.text)).toEqual(['Pear', 'Plum'])
  })

  it('presses nothing if the visible choice labels match multiple questions', async () => {
    const questions = [color, { ...color, question: 'Which color for the border?', header: 'Border' }]
    const dialog = fakeDialog(questions)
    dialog.write('3')
    const cropped = {
      ...dialog,
      lines: () => {
        const rows = dialog.lines()
        return dialog.state.tab === 1 ? rows.slice(rows.findIndex(row => row.startsWith('❯ 1. Red'))) : rows
      }
    }
    expect(readQuestionScreen(cropped.lines())?.question).toBeNull()
    const { answerer, held } = answererFor(cropped)
    const result = await answerer.answer(questions, [{ picks: [0], other: null }, { picks: [1], other: null }])

    expect(result).toEqual({ ok: false, reason: 'changed' })
    expect(dialog.state.tab).toBe(1)
    expect(dialog.state.keys).toEqual(['3'])
    expect(dialog.state.submitted).toBeNull()
    expect(held).toEqual([true, false])
  })

  it('withholds Enter if the question scrolls off after moving the preview selection', async () => {
    const preview = { ...color, options: color.options.map(option => ({ ...option, preview: option.description })) }
    const questions = [preview, { ...preview, question: 'Which color for the border?', header: 'Border' }]
    const dialog = fakeDialog(questions)
    let framesAfterMove = 0
    const cropped = {
      ...dialog,
      lines: () => {
        const rows = dialog.lines()
        // Show the new selection in its original frame before the preview repaints in a low pane.
        if (dialog.state.tab !== 0 || !dialog.state.keys.length || framesAfterMove++ === 0) return rows
        return rows.slice(rows.findIndex(row => row.includes('1. Red')))
      }
    }
    const { answerer } = answererFor(cropped)
    const result = await answerer.answer(questions, [{ picks: [1], other: null }, { picks: [2], other: null }])

    expect(result).toEqual({ ok: false, reason: 'changed' })
    expect(dialog.state.tab).toBe(0)
    expect(dialog.state.keys).toEqual(['2'])
    expect(dialog.state.submitted).toBeNull()
  })
})

describe('three and four questions', () => {
  const pick = (question, header, multiSelect) => ({ question, header, multiSelect, options: [{ label: 'Alpha', description: 'a' }, { label: 'Beta', description: 'b' }, { label: 'Gamma', description: 'c' }] })

  it('answers each in turn, a checklist last moving on with its Submit row', async () => {
    const questions = [pick('배포 환경은?', '환경', false), pick('켤 기능은?', '기능', true), pick('알릴 채널은?', '채널', true)]
    const dialog = createFakeAskDialog(questions)
    const { answerer } = answererFor(dialog)
    const answers = [{ picks: [1], other: null }, { picks: [0, 2], other: '델타' }, { picks: [1], other: null }]
    expect(await answerer.answer(questions, answers)).toEqual({ ok: true })
    expect(dialog.state.submitted).toEqual(['Beta', 'Alpha, Gamma, 델타', 'Beta'])
  })

  it('answers four (Claude’s most), typed and picked, ending on a single choice', async () => {
    const questions = [pick('켤 기능은?', '기능', true), pick('이름은?', '이름', false), pick('순서는?', '순서', false), pick('마지막 확인?', '확인', false)]
    const dialog = createFakeAskDialog(questions)
    const { answerer } = answererFor(dialog)
    const answers = [{ picks: [2], other: null }, { picks: [], other: '직접 이름' }, { picks: [0], other: null }, { picks: [2], other: null }]
    expect(await answerer.answer(questions, answers)).toEqual({ ok: true })
    expect(dialog.state.submitted).toEqual(['Gamma', '직접 이름', 'Alpha', 'Gamma'])
  })
})
