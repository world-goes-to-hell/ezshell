# Browser Tab Links and Menu (브라우저 탭의 새 창 링크·우클릭 메뉴)

[공통 작업 규칙과 기능별 목록](../../CLAUDE.md)

브라우저 탭의 페이지(`src/ipc/browserReview.js` 의 `createTab`)에서 새 창으로 여는 링크(`target="_blank"`, `window.open`, Ctrl·가운데 클릭)는 앱의 새 브라우저 탭에서 연다 (`openLink`, http(s) 만). 우클릭은 Electron 기본 메뉴다 (`src/ipc/browserContextMenu.js`: 링크·이미지·입력칸·선택·빈 곳마다 다른 항목, 맨 아래 `검사` 는 개발자 도구를 따로 띄운 창으로 열고 `inspectElement`). 페이지 안의 키는 F12·`Ctrl+Shift+I`(개발자 도구), `Alt+←/→`, `F5`·`Ctrl+R`. 바꾸면 안 되는 것: 페이지는 앱 화면 위에 그려지므로 HTML 메뉴로 바꾸면 가려진다. 새 창(`action: 'allow'`)을 허용하지 않는다 (앱의 세션·샌드박스 규칙 밖의 창이 생긴다). 2026-11-23 사용자 보고. 설명: `docs/fix/2026-11-23-browser-tab-links-context-menu.md`. 화면 테스트 `browser-review`.
