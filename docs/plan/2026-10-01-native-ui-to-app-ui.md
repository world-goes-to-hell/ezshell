# OS 기본 UI(확인 창, 알림 창, 선택 목록)를 앱 디자인으로

## 요청 (사용자, 2026-10-01)
사이드바 확인 창처럼 앱 디자인 없이 OS 기본 모양으로 뜨는 곳 점검 결과 중 1~4 전부 진행.

## 범위
1. **color-scheme**: 테마가 어두워도 OS 가 그리는 요소(펼친 select 목록, 색 선택기, 스크롤바 등)가 밝게 그려진다.
   - 테마를 적용할 때 테마의 `bgPrimary` 밝기로 `document.documentElement.style.colorScheme` 를 dark/light 로 설정
   - CSS 블록마다 적지 않는 이유: 사용자 테마는 CSS 블록이 없고 테마 정의(colors)만 있다. 적용 시점에 계산하면 프리셋/사용자 테마/별도 창(initializeTheme) 모두 적용
2. **confirm() 7곳 → `confirmDialog`** (MCP 2곳은 다른 세션 작업 중이라 제외)
   - SFTP 파일 이동(드래그), SFTP 로컬 휴지통, SFTP 원격 삭제(되돌릴 수 없음), 명령어 기록 전체 삭제, 테마 삭제, 스니펫 삭제(영어 문구), 단축키 초기화(영어 문구)
   - 삭제류는 빨간 버튼 + 첫 포커스 "취소"
   - `ConfirmDialogHost` 를 SFTP 별도 창, 터미널 별도 창에도 마운트 (SFTP 작업이 별도 창에서도 일어남)
3. **alert() 3곳**: 테마 편집기 이름 누락 → 입력칸 아래 오류 문구, 테마 가져오기 성공/실패 → 토스트
4. **`<select>` 3곳 → 앱 디자인 드롭다운** (`components/ui/SelectMenu.tsx`, 기존 의존성 Radix DropdownMenu 의 RadioGroup 사용 — 키보드/스크린리더 지원)
   - SFTP 로컬 드라이브, 설정 터미널 글꼴(항목마다 그 글꼴로 미리보기), 스니펫 분류 필터("All Categories" → "전체 분류")

## 진행
- [x] `lib/colorScheme.ts`(테스트 3개, 프리셋 20개 모두 올바르게 판정) + themeStore `applyThemeToDocument` (setTheme / initializeTheme)
- [x] confirm 7곳: SFTP 이동("항목 이동", MoveDeps.confirm 이 Promise 도 받음 + 테스트), 로컬 휴지통, 원격 삭제, 명령 기록 삭제, 테마 삭제(테마 이름 표시), 스니펫 삭제(영어 → 한국어, 이름 표시), 단축키 초기화(영어 → 한국어, 바꾼 개수 표시). 삭제/초기화는 danger
- [x] ConfirmDialogHost 를 SFTP / 터미널 별도 창에도 마운트
- [x] alert 3곳: 테마 이름 누락 → 입력칸 아래 오류 문구(role=alert, aria-invalid, 포커스 이동), 가져오기 성공/실패 → 토스트. 이름 placeholder 도 한국어로
- [x] `components/ui/SelectMenu.tsx`: SFTP 드라이브(compact), 터미널 글꼴(항목마다 글꼴 미리보기), 스니펫 분류("전체 분류"). 쓰지 않게 된 `.drive-select`, `.font-family-select`, 이전 `.snippet-category-filter` 규칙 제거
- [x] 타입 체크(다른 세션 작업 중인 SessionTabBadge.tsx 제외), 전체 테스트 통과
- [x] 코드 리뷰: HIGH 1(스니펫 관리자 z-index 10000 위에서 확인 모달/드롭다운이 뒤에 깔림 → 확인 배경 15000 / 모달 15001 / 목록 15002, MCP 승인 20000 아래), MEDIUM 2(설정 위 확인 모달 배경 dim, 사라진 분류 필터 → "전체 분류") 모두 반영
- [x] 실제 앱 확인: color-scheme(테마 전환·재시작·별도 창·색 선택기·스크롤바), 확인 모달 7곳(취소/확정, 첫 포커스, 다른 모달 위, SFTP 별도 창 안), alert 대체 3곳, SelectMenu 3곳(키보드·다크/라이트), OS 대화상자 0회
- 검증 중 발견(기존 문제, 미처리)
  - 테마 가져오기: `preview` 없는 JSON 을 받아들여 저장 → 테마 목록이 `theme.preview.primary` 를 읽다 TypeError 로 앱 화면 전체가 사라짐. 저장된 채 남아 설정을 열 때마다 재발 (심각)
  - 테마 카드가 `<button>` 안에 `<button>` (React 경고)
  - (원인 미확인) 연결 직후 입력한 `ls -al`, `pwd` 중 `pwd` 만 명령 기록에 남음
- 남은 것: MCP 화면의 window.confirm 2곳(다른 세션 작업 중), 스니펫 검색 placeholder "Search snippets..." 등 영어 문구
