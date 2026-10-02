# 설정 > 테마 탭에서 스크롤바가 두 개 생기던 문제

## 증상
- 설정 모달의 테마 탭에서 탭 내용 전체와 테마 카드 목록에 스크롤바가 각각 생겼다. 휠을 굴리면 어느 쪽이 움직일지 위치에 따라 달랐다.

## 원인
- 탭 내용 `.settings-content` 가 `height: 100%; overflow-y: auto` 로 스크롤된다 (실측: 427px 안에 564px).
- 그 안의 `.theme-grid` 도 `max-height: 360px; overflow-y: auto` 로 따로 스크롤된다 (360px 안에 983px).
- 모달 높이(600px 또는 80vh)에서 제목, 설명, 버튼, 필터 탭을 빼면 남는 높이가 360px 보다 작아서 바깥도 넘쳤다.

## 수정
- `.theme-grid` 의 `max-height` 와 `overflow-y` 를 없앴다. 스크롤은 `.settings-content` 하나만 한다.
- 대신 카드 목록을 내려도 "커스텀 테마 만들기 / 가져오기" 버튼과 필터 탭이 계속 보이도록, 둘을 `.theme-toolbar` 로 묶어 `position: sticky` 로 위에 고정했다 (`ThemeSelector.tsx`, `settings.css`).
  - 배경을 `--bg-secondary`(모달 배경)로 채워 아래로 지나가는 카드가 비치지 않게 했다.
  - sticky 는 스크롤 영역의 padding 안쪽에 붙으므로 `.settings-content` 의 위 여백 8px 만큼 `top: -8px` 로 올렸다.
  - 툴바 아래 여백 8px 은 음수 마진으로 돌려줘서 필터와 카드 사이 간격은 그대로다.

## 검증
- 실제 앱 (격리 프로필 + CDP)
  - 수정 전: 스크롤되는 요소 2개 (`settings-content`, `theme-grid`)
  - 수정 후: `settings-content` 하나 (427px 안에 1187px). 끝까지 내려도 툴바 윗변 = 스크롤 영역 윗변, 마지막 카드까지 보임
  - 라이트 필터처럼 카드가 적으면 스크롤 자체가 없음
