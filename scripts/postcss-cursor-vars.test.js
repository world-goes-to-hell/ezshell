import { describe, expect, it } from 'vitest'
import postcss from 'postcss'
import plugin from './postcss-cursor-vars.cjs'

const run = css => postcss([plugin()]).process(css, { from: undefined }).css

describe('postcss cursor vars', () => {
  it('makes each pointer keyword read the chosen image, falling back to the keyword', () => {
    expect(run('.a{cursor:pointer}')).toBe('.a{cursor:var(--ez-cursor-pointer, pointer)}')
    expect(run('.xterm{cursor: text}')).toBe('.xterm{cursor: var(--ez-cursor-text, text)}')
    expect(run('.d{cursor:ns-resize}')).toBe('.d{cursor:var(--ez-cursor-row-resize, ns-resize)}')
    expect(run('.e{cursor:ew-resize !important}')).toBe('.e{cursor:var(--ez-cursor-col-resize, ew-resize) !important}')
    expect(run('.f{cursor:POINTER}')).toBe('.f{cursor:var(--ez-cursor-pointer, pointer)}')
    expect(run('.g{cursor:default}')).toBe('.g{cursor:var(--ez-cursor-default, default)}')
    expect(run('.h{cursor: pointer /* why */}')).toBe('.h{cursor: var(--ez-cursor-pointer, pointer) /* why */}')
  })

  it('leaves other values alone', () => {
    for (const css of ['.a{cursor:move}', '.a{cursor:zoom-in}', '.a{cursor:url(x.png) 1 1, pointer}', '.a{cursor:inherit}', '.a{color:pointer}',
      '.a{cursor:-webkit-grab}', '.a{cursor:none}', '.a{cursor:auto}', '/* cursor: pointer */.a{}']) {
      expect(run(css)).toBe(css)
    }
  })
})
