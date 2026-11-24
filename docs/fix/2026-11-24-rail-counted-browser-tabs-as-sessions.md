# 접힌 사이드바가 브라우저 탭을 연결된 SSH 세션으로 셈

작성: 2026-11-24 (사용자 보고: 브라우저 탭 6개를 열자 접힌 사이드바의 목록 아이콘 아래 초록 숫자가 7이 됐다)

## 원인
접힌 사이드바의 숫자는 `lib/sidebarRail.ts` 의 `railCounts` 가 센다. DB 탭과 로컬 터미널은 빼고 나머지를 모두 세션 탭으로 셌는데, 브라우저 탭(`TerminalInfo.browser`)을 빼지 않았다. 브라우저 탭은 `connected` 가 참이라 연결된 세션으로 들어갔다. 상태 줄의 연결 수(`Footer.tsx`)는 공용 판정 `lib/sessionTabs.ts` 의 `isSshTab`(DB·로컬·브라우저 제외)을 써서 맞게 세고 있었다.

## 수정
`railCounts` 도 `isSshTab` 으로 세션 탭을 고른다 (로컬 터미널은 그 전에 따로 센다). CLAUDE.md 의 지침 "SSH 탭인지 볼 때는 `.db` 만 보지 말고 이 함수를 쓴다" 를 이 계산이 따르지 않았던 것이다.

같은 종류의 빈틈 하나: 브라우저 탭을 로컬 작업 카드에 끌어 놓으면 "빠른 연결은 세션으로 저장한 뒤 묶어 주세요" 가 떴다 (`localProjectServers.ts` 의 `sessionFromDrop`). 이제 "로컬 터미널·DB·브라우저 탭은 묶을 수 없습니다" 로 답한다.

## 시험
`sidebarRail.test.ts` 의 "does not count browser tabs as sessions, in the list or under local work" (고치기 전 실패 확인), `localProjectServers.test.ts` 의 브라우저 탭 경우. `vitest related` 로 두 파일에 걸린 테스트, 타입 검사, 빌드.
