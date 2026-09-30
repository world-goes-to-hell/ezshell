# 명령어 기록 팝업의 "기록 없음" 문구가 잘 안 읽힘

- 작성일: 2026-09-30

## 증상
터미널에서 `Ctrl+Shift+H` 로 명령어 기록 팝업을 열었을 때, 기록이 없으면 나오는
"아직 기록된 명령어가 없습니다. 터미널에서 명령을 실행하면 여기에 쌓입니다" 문구가 흐려서 읽기 어렵다.

## 원인
- `.history-empty` 가 **12px + `--text-muted`** 였다. 긴 한 문장이 두 줄로 꺾여 나왔다.
- 사용 중인 `ayu-mirage` 테마에서 `--text-muted`(#707a8c) / `--bg-secondary`(#232834) 대비는 **3.41:1**.
  작은 글자 기준(WCAG AA 4.5:1)에 못 미친다. 12px 한글은 획이 뭉개져 더 흐리게 보인다.

## 수정
| 항목 | 이전 | 이후 |
|---|---|---|
| 구성 | 한 문장 | 제목 + 안내 두 줄 |
| 제목 | 12px `--text-muted` | 14px, 500, `--text-primary` (ayu-mirage 9.12:1) |
| 안내 | (제목과 합쳐짐) | 13px `--text-secondary` (ayu-mirage 6.09:1) |

- 팝업(`CommandHistoryPopup`)과 기록 패널(`CommandHistoryPanel`)이 같은 문구 로직을 중복으로 갖고 있어서
  `lib/commandHistoryEmpty.ts`(문구 선택, 테스트 3개)와 `CommandHistoryEmpty.tsx`(표시)로 합쳤다.

## 검증
- 테스트 209개 통과, 타입 체크 오류 0건.
- 임시 SSH 서버에 연결한 개발 앱에서 `Ctrl+Shift+H` 로 팝업을 열어 계산된 스타일 확인:
  제목 14px/본문색, 안내 13px/보조색.

## 남은 문제 (이번 범위 밖)
- 전체 20개 테마 중 **17개에서 `--text-muted` 대비가 4.5:1 미만**이다. 앱 곳곳의 작은 흐린 글씨가 같은 문제를 가질 수 있다.
- `solarized-light` 는 `--text-secondary` 도 4.39:1 로 기준에 약간 못 미친다.
