import { describe, expect, it } from 'vitest'
import { insertChatImages, resolveChatImages } from './chatImageReferences'

const first = { id: 'a', number: 1 }
const second = { id: 'b', number: 2 }
const third = { id: 'c', number: 3 }

describe('image positions in a chat draft', () => {
  it('inserts at the selected text and leaves the caret after the image and its comment', () => {
    expect(insertChatImages('앞선택뒤', 1, 3, [first], '캡처 설명')).toEqual({
      text: '앞 [첨부이미지 1]\n캡처 설명 뒤',
      caret: '앞 [첨부이미지 1]\n캡처 설명 '.length
    })
  })

  it('puts images in the order of their references and renumbers the submitted text', () => {
    const result = resolveChatImages('[첨부이미지 2] 버튼을 누르니 [첨부이미지 1] 이렇게 됐어. 다시 [첨부이미지 2]를 봐 줘.', [first, second, third])
    expect(result).toEqual({
      text: '[첨부이미지 1] 버튼을 누르니 [첨부이미지 2] 이렇게 됐어. 다시 [첨부이미지 1]를 봐 줘.',
      images: [second, first]
    })
  })

  it('supports image-only messages, unknown references and deleting a reference', () => {
    expect(resolveChatImages(' [첨부이미지 3] [첨부이미지 2] ', [first, second, third])).toEqual({ text: '', images: [third, second] })
    expect(resolveChatImages(' [첨부이미지 9] ', [first])).toEqual({ text: '[첨부이미지 9]', images: [] })
    expect(resolveChatImages(' 다른 질문 ', [first])).toEqual({ text: '다른 질문', images: [] })
  })
})
