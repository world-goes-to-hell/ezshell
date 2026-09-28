# 분할 터미널: 선택하지 않은 터미널의 커서가 `||` 로 보임

- 작성일: 2026-09-28

## 증상
분할 화면에서 입력 중이 아닌 터미널의 프롬프트 뒤에 커서가 두 줄(`[root@host ~]#||`)로 보인다.

## 원인
xterm 5.3 의 `cursorInactiveStyle` 기본값은 `'outline'` 이다. 포커스가 없는 터미널에서는 커서 칸 전체에
`outline: 1px solid` 를 두르는데(`node_modules/xterm/lib/xterm.js` 의 `.xterm-cursor-outline`),
좁은 글자 칸에서는 테두리의 좌우 선이 두 개의 막대처럼 보인다. 분할 화면에서는 입력 중인 한 곳을 뺀
나머지 터미널이 모두 포커스가 없으므로 항상 이 모양이 나타난다.

## 수정
`TerminalPanel`, `SplitTerminal`, `TerminalWindow` 의 xterm 옵션에 `cursorInactiveStyle: 'bar'` 추가.
포커스가 없을 때도 활성 커서와 같은 막대 하나로 표시된다 (깜빡임만 멈춤).
