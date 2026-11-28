# 목업 만들기 (ezShell 디자인으로)

[공통 작업 규칙과 기능별 목록](../CLAUDE.md)

2026-11-28 사용자 요청: 에이전트가 만든 목업이 색과 서체를 새로 지어내(베이지 종이, 민트 강조 등) 무엇을 바꾸자는 것인지 읽기 어려웠다. 목업은 실제 앱의 화면과 CSS 에서 시작한다.

## 시작 틀 만들기

```bash
npm run build
npm run mockup:kit                          # 기본 테마
npm run mockup:kit -- --theme minimal-light # 다른 테마 (mockups/_kit/themes.json 의 id)
```

`scripts/mockup-kit.cjs` 가 빌드된 앱을 화면 테스트처럼 숨긴 창으로 띄운다 (임시 프로필, `e2e/support/localAgentApp.js` 의 가짜 에이전트, CDP 포트 19420, `MOCKUP_KIT_PORT` 로 바꿈). 로컬 작업 하나(커밋하지 않은 변경 둘), 에이전트 탭, 작업 공간 패널의 `변경` 탭을 연 화면을 떠서 `mockups/_kit/` 에 쓴다.

- `ezshell.css`: 페이지의 모든 스타일 규칙 (37개 테마 포함). 글꼴(Pretendard, JetBrains Mono, D2Coding)은 `assets/` 에 복사한다.
- `app.html`: 그 화면의 정적 HTML (스크립트 없음, 1440×900). 다른 테마는 `app.<테마 id>.html`.
- `app-real.png`: 같은 순간의 실제 앱 캡처. 목업이 앱과 같아 보이는지 비교할 때 쓴다.
- `themes.json`: CSS 에 있는 테마 id 목록.
- 홈·임시 폴더 경로는 `C:\work\sample-service` 로, 버전은 `package.json` 의 버전으로 바꿔 둔다.
- `mockups/_kit/` 은 만들 때마다 지우고 새로 쓴다 (다른 테마 파일은 남김). 커밋하지 않는다.

## 목업을 만들 때 (에이전트 공통 규칙)

1. `mockups/_kit/app.html` 을 `mockups/<기능>.html` 로 복사하고, `ezshell.css` 링크를 `_kit/ezshell.css` 로 바꾼다. 틀이 없으면 위 명령으로 만든다.
2. 바꾸려는 영역만 고친다. 나머지 화면(제목 줄, 사이드바, 탭 줄, 상태 줄)은 그대로 두어, 새 것이 어디에 놓이는지 보이게 한다.
3. 새 부품은 앱에 이미 있는 클래스와 CSS 변수(`var(--bg-primary)`, `var(--accent)`, `var(--text-secondary)` 등)로 만든다. 색·서체·모서리 값을 새로 짓지 않는다. 새로 필요한 스타일은 목업 파일의 `<style>` 에 변수로만 적는다.
4. 여러 안을 보일 때는 같은 틀을 안마다 복사해 나란히 둔다 (한 파일에 `<section>` 여럿, 또는 파일 여럿).
5. 테마가 의미 있는 변경(색, 대비)이면 다크(`app.html`)와 라이트(`app.minimal-light.html`) 둘 다로 보인다.
6. 다 만든 뒤 Edge 헤드리스로 캡처해 `app-real.png` 와 나란히 보고, 바꾼 곳 말고 달라진 데가 없는지 확인한다:
   `msedge --headless=new --user-data-dir=<임시 폴더> --window-size=1440,900 --screenshot=<png> file:///<목업 경로>`

## 한계

- 정적 HTML 이라 동작(펼치기, 끌기, 애니메이션)은 없다. 상태가 여럿이면 상태마다 화면을 따로 둔다.
- 테마는 `data-theme` 만 바꿔서는 다 바뀌지 않는다: 앱이 `<html>` 의 인라인 style 에 테마 색 변수를 넣고, 터미널 글자색이 인라인이다. 그래서 테마마다 따로 뜬다.
- 화면 하나(기본 배치)만 뜬다. 설정 창·대화 상자처럼 다른 화면이 필요하면 스크립트에 그 화면을 여는 단계를 더한다.

ai-mockup-mcp(사용자의 목업 MCP)에서 같은 생각을 모든 프로젝트용 기능("프로젝트 디자인 가져오기·점검")으로 만드는 일은 그 저장소 담당 에이전트에게 넘겼다 (2026-11-28).
