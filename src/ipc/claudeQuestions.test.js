import { describe, expect, it } from 'vitest'
import { createClaudeQuestionAnswerer, readQuestionScreen, readReview } from './claudeQuestions.js'
import { createFakeAskDialog } from '../../e2e/support/fakeAskDialog.js'
import { withoutOverlayBox } from './cliOverlayBox.js'

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

  it('does not read a low pane’s "↑ 2 more lines" row as part of the last answer (real CLI at 90×18)', () => {
    const review = readReview(['Review your answers', '', ' │ ● Which color?', '   → Green', ' ↑ 2 more lines', '❯ 1. Submit answers', '  2. Cancel'])
    expect(review.entries).toEqual([{ question: 'Whichcolor?', answer: 'Green' }])
  })

  it('reads a review whose heading a low pane scrolled off, the pane full of it (real CLI at 80×16)', () => {
    const rows = ['   do you like?', '   → Apple', ' │ ● Which color?', '   → Green', ' ↑ 5 more lines', '❯ 1. Submit answers', '  2. Cancel']
    expect(readReview(rows)).toEqual({ entries: [{ question: 'Whichcolor?', answer: 'Green' }], unanswered: false, ready: true })
    // Without the "more lines" row there is nothing to say the rows above are the review
    expect(readReview(rows.filter(row => !row.includes('more lines')))).toBeNull()
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

// A plugin's notice box drawn over the top right of the screen (this PC's ko-ui), its bottom border on the
// blank row under the tab strip: the card stopped after the first answer and handed the rest to the
// terminal (2026-11-27 user report, real Claude Code 2.1.332 at 110×20)
describe('a notice box over the dialog', () => {
  const NOTICE = ['╭' + '─'.repeat(22) + '╮', '│ ko-ui' + ' '.repeat(16) + '│', '│ 번역 안 된 새 항목  │', '╰' + '─'.repeat(22) + '╯']
  // `lower`: rows the box lies further down; at 1 its bottom border covers the end of the question's row
  const underNotice = (dialog, lower = 0) => ({
    ...dialog,
    lines: () => {
      const rows = dialog.lines()
      const strip = rows.findIndex(row => row.startsWith('←'))
      return rows.map((row, index) => {
        const part = NOTICE[index - (strip - 2 + lower)]
        return part ? row.slice(0, 50).padEnd(50) + part : row
      })
    }
  })

  it('reads the question without the box’s border or text (rows of the real CLI)', () => {
    const screen = readQuestionScreen([
      '─────────────────────────────────────────────────────────────────────│ /ko-dump 로 목록을 보고 dict.json 에  │',
      '←  ☒ DB 구축일  ☐ 코드 제정일  ☐ 엔티티 현황  ☐ 개인정보  ✔ Submit  →│ 번역을 추가하세요                     │',
      '                                                                     ╰───────────────────────────────────────╯',
      "│ [6/8] 표준코드정의서(C003)와 데이터코드목록(C008)의 '제정일자' 칸 509건이 비어 있습니다. 각 코드를 언제",
      '│ 만들었는지 적는 칸입니다. 어떻게 채울까요?',
      '',
      '❯ 1. DB 등록일시로 채움 (Recommended)',
      "     코드 테이블에 등록일시가 있으면 그 날짜를 넣고, 없으면 '-' 를 넣습니다.",
      "  2. 모두 '-' 로 비움",
      '  3. 확인 필요로 남김',
      '  4. Type something.',
      '─'.repeat(110),
      '  5. Chat about this',
      '',
      'Enter to select · Tab/Arrow keys to navigate · Esc to cancel'
    ])
    expect(screen.question).toBe("[6/8]표준코드정의서(C003)와데이터코드목록(C008)의'제정일자'칸509건이비어있습니다.각코드를언제만들었는지적는칸입니다.어떻게채울까요?")
    expect(screen.options.map(option => option.text)).toEqual(['DB 등록일시로 채움 (Recommended)', "모두 '-' 로 비움", '확인 필요로 남김', 'Type something.', 'Chat about this'])
  })

  it('answers every question while the box stays over the dialog', async () => {
    const pick = (question, header) => ({ question, header, multiSelect: false, options: [{ label: 'Alpha', description: 'a' }, { label: 'Beta', description: 'b' }, { label: 'Gamma', description: 'c' }] })
    const questions = [pick('구축일은?', '구축일'), pick('제정일은?', '제정일'), pick('현황은?', '현황'), pick('분류는?', '분류')]
    const dialog = underNotice(createFakeAskDialog(questions))
    const { answerer } = answererFor(dialog)
    const answers = [{ picks: [2], other: null }, { picks: [0], other: null }, { picks: [], other: '모두 신규' }, { picks: [0], other: null }]
    expect(await answerer.answer(questions, answers)).toEqual({ ok: true })
    expect(dialog.state.submitted).toEqual(['Gamma', 'Alpha', '모두 신규', 'Alpha'])
  })

  it('knows a question whose row the box covers in part by its pieces in order (rows of the real CLI)', async () => {
    const real = [
      '                                                 ╭───────────────────────────────────────╮',
      '─────────────────────────────────────────────────│ ko-ui                                 │',
      '←  ☐ DB 구축일  ☐ 코드 제정일  ☐ 엔티티 현황  ☐  │ ko-ui: 번역 안 된 새 항목 8개 발견.   │',
      '                                                 │ /ko-dump 로 목록을 보고 dict.json 에  │',
      "│ [5/8] 데이터베이스 정의서(C011)의 '개발 DB 최초│ 번역을 추가하세요                     │",
      '│ 날짜가 기록되지 않아서 저장소나 DB 로는 확인할 ╰───────────────────────────────────────╯',
      '',
      "❯ 1. '-' 로 비움 (Recommended)",
      '  2. 구축일을 알려줌',
      '  3. 확인 필요로 남김',
      '  4. Type something.',
      '─'.repeat(90),
      '  5. Chat about this',
      '',
      'Enter to select · Tab/Arrow keys to navigate · Esc to cancel'
    ]
    const screen = readQuestionScreen(real)
    expect(screen).toMatchObject({ cut: true, parts: ["[5/8]데이터베이스정의서(C011)의'개발DB최초", '날짜가기록되지않아서저장소나DB로는확인할'] })
    const db = { question: "[5/8] 데이터베이스 정의서(C011)의 '개발 DB 최초 구축일' 칸을 어떻게 할까요? DB 에는 만든 날짜가 기록되지 않아서 저장소나 DB 로는 확인할 수 없습니다.", header: 'DB 구축일', multiSelect: false,
      options: [{ label: "'-' 로 비움 (Recommended)", description: '' }, { label: '구축일을 알려줌', description: '' }, { label: '확인 필요로 남김', description: '' }] }
    const keys = []
    const { answerer } = answererFor({ lines: () => (keys.length ? [] : real), write: key => keys.push(key) })
    expect(await answerer.answer([db], [{ picks: [2], other: null }])).toEqual({ ok: true })
    expect(keys).toEqual(['3'])
  })

  it('answers questions whose rows and review the box covers in part', async () => {
    const long = (number, topic) => ({ question: `[${number}/4] ${topic} 칸이 비어 있는데, 문서마다 기준이 달라서 어떻게 채울지 정해야 합니다. 어떻게 할까요?`, header: topic, multiSelect: false,
      options: [{ label: 'Alpha', description: 'a' }, { label: 'Beta', description: 'b' }, { label: 'Gamma', description: 'c' }] })
    const questions = [long(1, '구축일'), long(2, '제정일'), long(3, '현황'), long(4, '분류')]
    const dialog = underNotice(createFakeAskDialog(questions), 1)
    expect(dialog.lines().find(row => row.includes('[1/4]'))).toContain('╰')
    const { answerer } = answererFor(dialog)
    const answers = [{ picks: [2], other: null }, { picks: [0], other: null }, { picks: [], other: '모두 신규' }, { picks: [1], other: null }]
    expect(await answerer.answer(questions, answers)).toEqual({ ok: true })
    expect(dialog.state.submitted).toEqual(['Gamma', 'Alpha', '모두 신규', 'Beta'])
  })

  it('does not take covered pieces that fit two questions of the batch for either', async () => {
    // Alike up to where the box starts (column 50): told apart only by what it covers
    const same = topic => ({ question: `[1/2] 문서의 빈 칸을 어떻게 채울지 정해야 하는데, 기준이 문서마다 달라서 하나로 정해야 합니다. 대상: ${topic}`, header: topic, multiSelect: false,
      options: [{ label: 'Alpha', description: 'a' }, { label: 'Beta', description: 'b' }] })
    const questions = [same('구축일'), same('제정일')]
    const dialog = underNotice(createFakeAskDialog(questions), 1)
    const { answerer } = answererFor(dialog)
    expect(await answerer.answer(questions, [{ picks: [0], other: null }, { picks: [1], other: null }])).toEqual({ ok: false, reason: 'changed' })
    expect(dialog.state.keys).toEqual([])
  })

  it('keeps a row that is the dialog’s own frame', () => {
    expect(withoutOverlayBox('│ 질문 │')).toBe('│ 질문 │')
    expect(withoutOverlayBox('  ╰──╯')).toBe('  ╰──╯')
    expect(withoutOverlayBox('질문 문장 끝│ ko-ui │')).toBe('질문 문장 끝')
    expect(withoutOverlayBox('          ╰──────╯')).toBe('')
  })
})
