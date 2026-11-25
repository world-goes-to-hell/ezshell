# Startup Splash (시작 화면)

[공통 작업 규칙과 기능별 목록](../../CLAUDE.md)

앱을 켜면 main 이 본창 자리에 투명한 시작 창(`main.js` 의 `createStartupSplash`, 페이지 `startup.html?startupMode=true`)을 띄워 모션을 재생한다. 본창 화면이 준비되면(`app-startup-ready`) 시작 창이 앱 바탕색으로 창을 덮고(`ezshell-startup-covered`), main 이 그 아래에 본창을 보이게 한 뒤(`ezshell-startup-app-shown`) 덮개가 걷힌다 (`ezshell-startup-finished`). 시스템의 움직임 줄이기가 켜져 있으면 모션 없이 바로 본창이다.
- 모션(2026-11-20 부터): `startupMotions/bootPrompt.ts`(스타일 `styles/startupBoot.css`, 시안 `mockups/startup-boot-prompt.html`, 보관 시안은 `.v1.html`). 바탕화면 위 작은 터미널 창에서 `ezshell --boot` 를 사람이 치듯 친다 (글자 간격이 고르지 않고 낱말 사이에서 멈춤, 블록 커서는 치는 동안 켜져 있고 멈추면 깜빡임). 0.5초 쉬고 저절로 실행되어 `[ ok ]` 세 줄과 새 프롬프트를 찍고, 본창이 준비될 때까지 새 프롬프트에서 기다린다. 준비되면 그 창이 화면 가득 커지며 앱 바탕색이 되어(덮개) 그 아래에 본창이 보이고, 창이 사라진다. 누를 것이 없어서 시작 창은 포커스를 가져가지 않고 클릭이 통과한다. 창 색은 사용자 테마의 터미널 색이다 (`--t-bg`·`--t-fg`·`--t-green`(사용자·ok)·`--t-blue`(경로)·`--t-cursor`, 제목줄·흐린 글자는 바탕과 글자를 섞어 만듦). 본창과 시작 창이 같은 출처에 저장한 테마를 읽는다. 터미널 사각형은 테마 바탕색으로 채우고 창 바깥은 투명하게 둔다. 테마에 `chrome: mac`이 있으면 왼쪽에 신호등 모양, 다른 테마는 오른쪽에 테마 색의 창 버튼 모양을 그린다. `startup-theme` 화면 시험은 별도 프로필로 밝은 테마 둘과 어두운 테마 둘을 띄워 저장된 테마, 터미널 색과 창틀, 본창 전환을 확인한다. 시작 창에는 preload 가 없어 사용자의 터미널 글꼴 설정은 읽지 못한다 (JetBrains Mono 부터 고정폭 글꼴 순서). 준비된 뒤 모션을 기다리는 상한은 8초 (모션이 약 3.5초).
- 보관된 점 로고 모션은 `startupMotions/dotLogo.ts` 에 보관했다 (스타일은 `styles/startup.css`). `startup.ts` 에서 `playDotLogoStartup` 을 부르면 되돌아간다.
