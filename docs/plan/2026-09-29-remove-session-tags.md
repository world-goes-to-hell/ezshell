# 세션 태그 기능 제거

## 배경
세션 생성/수정 모달에서 태그 선택 기능을 제거한다. 태그를 지정할 수 있는 곳은 모달뿐이므로,
모달에서만 빼면 사이드바 태그 필터와 태그 뱃지가 쓸모없는 UI로 남는다. 사용자 결정에 따라 태그 기능 전체를 제거한다.

## 작업 항목
- [x] ConnectModal: 태그 선택 UI, `tags` 필드, 핸들러 제거
- [x] App.tsx: 세션 저장 시 `tags` 전달 제거
- [x] sessionStore: `Tag` 타입, `availableTags`/`activeTagFilter`, `addTag`/`removeTag`/`filterByTag`, `Session.tags` 제거
- [x] SessionList: 태그 필터 바, 태그 필터링 로직 제거
- [x] SessionItem / SessionTooltip: 태그 뱃지 표시 제거
- [x] TagSelector / TagBadge 컴포넌트와 CSS 삭제, globals.css 태그 스타일 삭제
- [x] typecheck / 테스트 통과 확인

## 호환성
기존에 저장된 세션 JSON의 `tags` 값은 읽을 때 무시된다. 세션을 다시 저장하면 필드가 빠진다.
