# 라이트 테마 추가

## 배경
- 기본 테마 20개 중 라이트는 3개(Minimal Light, Solarized Light, GitHub Light), 다크는 14개였다.

## 결정
- 이미 있는 다크 테마의 공식 라이트 짝 6개를 추가한다. 이름과 색은 각 테마의 공식 팔레트를 따른다.

| 추가 테마 | 짝 다크 테마 | 강조색 |
|---|---|---|
| Catppuccin Latte | Catppuccin Mocha | mauve #8839ef |
| Gruvbox Light | Gruvbox Dark | yellow #b57614 |
| Tokyo Night Day | Tokyo Night | blue #2a75d7 (공식 #2e7de9 를 흰 글자 4.5:1 까지만 어둡게) |
| Rosé Pine Dawn | Rosé Pine | iris #907aa9 |
| One Light | One Dark Pro | blue #3c70de (공식 #4078f2 를 같은 방식으로 조정) |
| Ayu Light | Ayu Mirage | orange #ffaa33 |

- `presets.ts`(1,200줄)와 `variables.css`(665줄)에 더하지 않고 `themes/lightPresets.ts`, `styles/themes-light.css` 로 분리했다. `PRESET_THEMES` 끝에 펼쳐 넣고, `globals.css` 가 CSS 를 불러온다.

## 대비 기준 (기존 테마 감사와 같음)
- `text-primary`, `text-secondary`: 세 배경(primary/secondary/tertiary) 모두 4.5:1 이상. `text-muted` 는 3:1 이상
- `--on-accent`: 흰색과 #16181c 중 강조색과 대비가 큰 쪽. 둘 다 4.5 미만이면 강조색을 흰 글자 4.5:1 이 될 때까지 어둡게
- hover/active 강조색은 글자색 반대 방향(글자가 짙으면 밝게, 흰색이면 어둡게)으로 바꿔 대비 유지
- `--text-link`, `--error-text`: 배경 위 4.5:1 이 될 때까지 공식 색을 어둡게
- 위험 버튼(`--error` 65% + 검정) 위 흰 글자 4.5:1 이상
- 공식 팔레트로 기준을 못 넘은 곳: Tokyo Night Day 는 `text-primary` 를 #3760bf → #3459b4, `bg-tertiary` 를 #dcdee7 로 조정
- 계산 스크립트는 세션 scratchpad 의 `light-themes.mjs` (팔레트 → 검사 → TS/CSS 생성)

## 터미널 색
- 터미널의 black 은 짙은 색, white 는 회색으로 둔다 (GitHub Light 와 같은 방식). 공식 팔레트에서 black 이 배경색과 같은 테마(Gruvbox, Tokyo Night Day, Rosé Pine Dawn)는 그대로 쓰면 검은 글자가 보이지 않는다.

## 검증
- `themes/presets.test.ts` 추가: id 중복 없음, 모든 프리셋에 같은 색의 `[data-theme]` CSS 블록 존재, 라이트 분류는 밝은 배경
- 전체 테스트 1082개 통과, 타입 검사 통과
- 실제 앱: 설정 > 테마 > 라이트 필터에 9개, 카드 클릭으로 6개 각각 적용 (data-theme, color-scheme: light, --bg-primary 일치), 터미널 ANSI 색 샘플과 함께 화면 캡처 확인
