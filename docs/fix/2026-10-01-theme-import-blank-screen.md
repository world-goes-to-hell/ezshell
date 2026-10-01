# 테마 가져오기로 앱 화면 전체가 사라지던 문제 + 테마 카드의 버튼 중첩

## 증상
- `preview` 가 없는 테마 JSON 을 가져오면 "테마를 가져왔습니다" 뒤에 앱 화면이 하얗게 사라졌다.
- 그 테마가 저장된 채 남아, 설정을 열 때마다 다시 사라졌다.
- 테마 카드에서 React 경고 "button cannot contain a nested button".

## 원인
1. `importTheme` 은 `id`, `name`, `colors`, `terminal` 이 있는지만 봤다. 각 색 값이나 `preview`, `category` 는 검사하지 않고 그대로 저장했다.
   테마 목록이 `theme.preview.primary` 를 읽다 TypeError → React 트리 전체가 내려갔다.
   persist 로 저장된 값은 불러올 때도 검사하지 않아, 한 번 들어온 깨진 테마가 계속 남았다.
2. 테마 카드 전체가 `<button>` 이고 그 안에 수정/내보내기/삭제 `<button>` 이 있었다.

## 수정
- `lib/themeValidation.ts` (테스트 8개)
  - `normalizeTheme`: 모든 앱/터미널 색이 있고 색 형식(hex, rgb(a), hsl(a), transparent)인지 검사. 하나라도 빠지거나 다른 값이면 거부
    (`red; background: url(x)` 같은 값도 거부). `preview`, `category` 가 없거나 잘못되면 색에서 만들어 채움. 이름 다듬기, 모르는 필드 버림
  - 색 키 목록은 `satisfies Record<keyof ThemeColors, 1>` 로 타입과 묶어, 타입에 색이 추가되면 컴파일 오류로 알 수 있게 함
  - `sanitizeStoredThemes`: 저장된 사용자 테마를 고치거나 걸러냄
- `themeStore`: `importTheme` 이 `normalizeTheme` 사용 (새 id 부여는 그대로), persist `merge` 에서 `sanitizeStoredThemes` 적용, 고른 테마가 걸러졌으면 기본 테마로
- `ThemeSelector`: 카드를 `div` 로, 선택은 `.theme-card-main` 버튼(aria-pressed), 동작 버튼은 그 옆 형제. 동작 버튼에 테마 이름이 들어간 aria-label.
  동작 버튼은 hover 뿐 아니라 키보드 포커스(`:focus-within`)에서도 보이게 함
- zod 는 쓰지 않음: 커밋된 package.json 에 없고 다른 작업(MCP)이 추가한 의존성이라 묶이지 않게 직접 검사

## 검증
- 프리셋 20개 모두 그대로 통과, preview 없는 파일 보정, 색 누락/잘못된 값 거부, 저장값 정리 (단위 테스트)
- 실제 앱: preview 없는 파일 가져오기 성공(미리보기는 테마 색), 색 누락/`red; background:url(x)`/JSON 아님 → 실패 토스트·미저장,
  localStorage 에 깨진 테마를 넣고 재시작 → 앱 정상, 보정 가능한 테마는 보정, colors 없는 테마는 제거, 현재 테마는 기본으로.
  중첩 버튼 경고 0건, Tab 으로 카드 동작 버튼 표시, 삭제는 확인 모달
