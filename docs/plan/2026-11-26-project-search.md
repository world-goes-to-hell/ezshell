# 프로젝트 검색: Shift 두 번(파일 찾기), Ctrl+Shift+F(내용 검색)

2026-11-26 사용자 요청: "ctrl + shift + f 로 현재 프로젝트 파일 내용검색 기능, shift + shift 로 현재 프로젝트 파일검색기능".

## 무엇을

- **현재 프로젝트**: 작업 공간 패널과 같은 폴더(`hooks/useWorkspaceDirectory`: 앞에 있는 로컬 탭의 셸 폴더, 그 저장소·워크트리). 로컬 탭이 아니면 검색 창에 "로컬 작업 탭에서 쓸 수 있습니다"를 보인다. SSH 서버 검색은 이번 범위가 아니다 (터미널의 `내용으로 파일 찾기` 가 있다).
- **창 하나, 두 모드**: 명령 팔레트처럼 가운데 뜨는 `프로젝트 검색` 창. 위에 `파일` / `내용` 탭, 프로젝트 이름. Shift 두 번은 `파일`, Ctrl+Shift+F 는 `내용` 으로 연다. 터미널에서 고른 글이 있으면 검색어로 채운다.
- **파일**: 이미 있는 색인 검색(`workspace-directory-search`, `src/localFiles/search.js`)을 그대로 쓴다. 이름·경로 일부로 찾고, 설치·빌드 폴더(`node_modules`, `build` 등)는 기본으로 빼고 `모두 포함` 을 켜면 넣는다.
- **내용**: 새 IPC `workspace-content-search`. 결과는 파일별로 묶고 줄 번호와 줄(찾은 부분 강조)을 보인다. `대소문자 구분` 켜기/끄기. 정규식은 이번에 넣지 않는다.
- **열기**: Enter·클릭은 그 파일을 파일 창으로 연다(`local-file-open`). 내용 결과는 그 줄로 간다 (`local-file-open` 에 `line` 을 더한다. 에이전트 대화 링크가 이미 줄로 여는 경로가 있다). 위·아래 화살표로 고르고 Esc 로 닫는다.

## 어떻게

- **내용 검색 (main, `src/localFiles/contentSearch.js`)**: 저장소면 `git grep -n -I --no-color -F --untracked --exclude-standard -e <검색어>` (무시 파일 제외, 이진 파일 제외, 고정 문자열). 저장소가 아니면 색인의 파일 목록을 직접 읽는다(파일당 1MB, 이진 파일 건너뜀). 둘 다 결과 500줄·파일 200개·8초에서 멈추고 "더 있음"을 알린다. 줄은 300자로 자른다. 새 검색이 오면 이전 검색을 끝낸다(`git` 프로세스 종료).
- **보안**: 본창 주 프레임·잠금 해제 확인, 폴더는 `roots.resolveRoot`(셸이 아는 폴더만), 검색어는 1~200자 한 줄, `execFile` 로 인수만 넘긴다(셸 없음, `-e` 뒤라 옵션으로 읽히지 않음). 결과 경로는 루트 기준 상대 경로만, 열 때 `resolveWorkspaceFile` 이 다시 검사한다.
- **단축키 (`stores/shortcutsStore.ts`)**: `프로젝트 내용 검색` Ctrl+Shift+F(바꿀 수 있음), `프로젝트 파일 찾기` Shift 두 번(고정, 끌 수 있음). Shift 두 번은 Shift 를 눌렀다 떼고 400ms 안에 다시 눌렀다 뗄 때만이다. 그 사이 다른 키가 하나라도 눌리면 아니다 (대문자·한글 쌍자음 입력은 Shift 와 글자 키가 섞여 해당하지 않는다). 터미널 안에서도 잡히도록 로컬·SSH 터미널의 키 처리(`attachCustomKeyEventHandler`)에 연결한다.

## 바꾸는 파일

새: `src/localFiles/contentSearch.js`(+시험), `components/ProjectSearch/ProjectSearch.tsx`·`.css`, `lib/projectSearch.ts`(묶기·강조·키 판정, +시험), `hooks/useDoubleShift.ts`, 화면 시험 `e2e/specs/project-search.js`.
고침: `src/ipc/localProjects.js`(IPC), `src/remoteFiles/ipc.js`(`line`), `src/preload.js`, `types/index.ts`, `stores/shortcutsStore.ts`, `hooks/useKeyboardShortcuts.ts`, 터미널 키 처리 3곳, `App.tsx`(창 올리기), 문서 `docs/architecture/workspace-files-git.md`·`global-shortcuts.md`.

## 시험

- 단위: 내용 검색(git·비저장소, 상한, 이진·큰 파일, 검색어 검사, 취소), 결과 묶기·강조, Shift 두 번 판정(다른 키가 끼면 아님, 400ms 넘으면 아님, 대문자 입력은 아님).
- 화면: 로컬 탭에서 Shift 두 번 → 파일 이름으로 찾고 Enter 로 파일 창, Ctrl+Shift+F → 내용 결과가 줄 번호와 함께 보이고 그 줄로 연다, 터미널에 포커스가 있을 때도 열린다, 로컬 탭이 아니면 안내.

## 진행

- [x] 사용자 승인 (2026-11-26)
- [x] main 내용 검색과 IPC
- [x] 검색 창과 단축키
- [x] 시험·문서 (단위: `contentSearch.test.js` 10, `projectSearch.test.ts` 7 / 화면: `project-search`)

계획과 달라진 것: Shift 두 번은 끄는 설정 없이 고정이다(설정의 키 기록으로는 입력할 수 없다). 검색어 미리 채우기는 화면에서 고른 글만이다(터미널 선택은 앱이 읽을 공통 경로가 없다). 터미널 키 처리 3곳 대신 창의 캡처 단계에서 듣는다. git grep 도 설치·빌드 폴더를 뺀다(화면 시험에서 무시되지 않은 `node_modules` 가 결과에 섞인 것을 보고 더함).
