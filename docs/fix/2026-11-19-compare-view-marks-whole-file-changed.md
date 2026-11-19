# 비교 화면이 긴 파일의 대부분을 "바뀜"으로 표시하던 문제 (2026-11-19)

## 증상

파일 창의 좌우 비교(백업·Git HEAD 와 비교)에서, 위쪽에 한 줄 들어갔을 뿐인데 그 아래 거의 모든 줄이 양쪽 모두 바뀐 것으로 칠해졌다 (사용자 보고, `src/remoteFiles/documents.js` 를 HEAD 와 비교).

## 원인

`RemoteCompareView.tsx` 가 `@codemirror/merge` 의 MergeView 에 `diffConfig: { scanLimit: 500, timeout: 300 }` 을 주고 있었다. 이 라이브러리는 글자 단위 Myers diff 인데, `scanLimit` 이 있으면 (앞뒤 공통 부분을 잘라 낸 뒤) 남은 구간이 약 4,000자를 넘을 때 대충 맞추기로 넘어가고, 약 16,000자를 넘으면 그 구간 전체를 변경 하나로 돌려준다. 남은 구간의 절반 이상이 통째로 같으면 반으로 나눠 풀어서(halfMatch) 몇 줄 끼워 넣은 정도는 정확했지만, 하루 작업처럼 여러 곳이 고루 바뀐 긴 파일에서는 첫 변경부터 마지막 변경까지가 전부 "바뀜"이 되었다.

## 수정

`scanLimit` 을 없애고 시간 제한(500ms)만 둔다 (`lib/compareDiff.ts` 의 `COMPARE_DIFF_CONFIG`). 시간을 넘기는 아주 크거나 많이 다른 파일에서만 라이브러리가 대충 맞추기로 넘어간다. 600줄·25KB 파일에 15곳 끼워 넣은 경우 계산은 약 9ms.

## 확인

`lib/compareDiff.test.ts`: 새 설정은 끼워 넣은 줄만 찾고, 옛 설정(`scanLimit: 500`)은 같은 입력에서 2만 자 넘게 "바뀜"으로 돌려주는 것(버그 재현)을 함께 본다. 화면 테스트 `ssh-remote-file`, `local-workspace-files` 통과.
