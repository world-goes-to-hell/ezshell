# 등록 세션용 MCP 서버 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claude Code 가 이 앱에 등록된 SSH 세션으로 서버를 조회할 수 있게, 앱 main 프로세스에 로컬 MCP 서버(Streamable HTTP)를 내장한다.

**Architecture:** `src/mcp/` 에 Electron 에 의존하지 않는 CommonJS 모듈(명령 정책, SSH 게이트웨이, 승인 중계, 감사 로그, 설정, MCP HTTP 서버)을 만들고, `controller.js` 가 이를 조립한다. `main.js` 는 컨트롤러를 만들고 잠금/세션 저장/종료 시점만 알려 준다. 렌더러에는 설정 > MCP 탭, 세션 모달의 허용 스위치, 확인 창을 추가한다.

**Tech Stack:** Electron 28.3.3 (Node 18.18.2), `@modelcontextprotocol/sdk` 1.31.0, `zod` 3, `ssh2` 1.15, React 19 + TypeScript, Vitest 3

**Spec:** `docs/plan/2026-10-01-mcp-server-design.md`

## Global Constraints

- main 프로세스는 Electron 28.3.3 / Node 18.18.2 다. `globalThis.crypto` 와 `AbortSignal.any` 가 없다. SDK 를 불러오기 전에 `globalThis.crypto = require('crypto').webcrypto` 를 채운다 (2026-10-01 실험으로 확인: 이것만 있으면 SDK 서버·클라이언트 왕복이 된다).
- `src/mcp/*.js` 는 CommonJS(`require` / `module.exports`). 테스트는 기존 `src/sshConnectionTest.test.js` 처럼 Vitest 에서 `import x from './x.js'` 로 기본 내보내기를 받는다.
- `main.js` 가 `require('./src/...')` 하는 파일은 번들되지 않고 복사된다. `electron.vite.config.ts` 에서 `src/mcp` 디렉터리를 `out/main/src/mcp` 로 복사해야 한다 (테스트 파일 제외).
- 의존성: `@modelcontextprotocol/sdk` 는 `1.31.0` 으로 고정, `zod` 는 `^3`. 둘 다 `dependencies` (패키징에 포함).
- 서버는 `127.0.0.1` 에만 바인딩. 기본 포트 `47521`. 경로 `/mcp`. 토큰은 64자 hex.
- 제한값: 확인 창 60초, 명령 실행 30초, 유휴 연결 5분, stdout·stderr 각 64KB, 요청 본문 1MB, 명령 길이 4000자, 경로 길이 1024자.
- 알림 수준 값: `'all' | 'medium' | 'danger'` (기본 `'danger'`). 위험도 값: `'low' | 'medium' | 'danger' | 'forbidden'`.
- 사용자에게 보이는 문구는 한국어. 코드 주석은 기존 파일처럼 영어.
- 파일 하나는 400줄 이하를 목표로 한다.
- **커밋은 사용자가 요청할 때만 한다** (사용자 규칙). 각 태스크 끝에서는 이 문서의 체크박스만 갱신한다.
- 사용자가 dev 모드 앱을 쓰는 중일 수 있다. main/preload 변경과 새 패키지 설치는 앱을 재시작해야 반영되므로, 반영 시점은 사용자에게 알린다 (`docs/brain/2026-09-28-dev-mode-edits-kill-live-terminal-sessions.md`).
- 테스트 실행: `npx vitest run <파일>`, 전체 `npx vitest run`, 타입 검사 `npm run typecheck`, 빌드 `npm run build`.

### 설계 문서와 달라진 점 (이유 포함)
| 항목 | 설계 문서 | 이 계획 | 이유 |
|---|---|---|---|
| MCP 설정 저장 위치 | `settings.json` 의 `mcp` 키 | `userData/mcp.json` (main 전용) | 렌더러가 `settings.json` 전체를 읽고-고치고-다시 쓴다(`terminalStore.ts:660`). main 이 같은 파일을 쓰면 서로 덮어쓴다 |
| 게이트웨이 테스트 | 테스트 안에서 `ssh2` 서버 | 가짜 ssh2 Client (기존 `sshConnectionTest.test.js` 방식) + Task 15 에서 실제 SSH 서버로 확인 | 단위 테스트가 빠르고 결정적이다. 실제 서버 확인은 통합 단계에서 한다 |
| 히어닥 | 중간 | 히어닥 본문 줄이 명령으로 해석되어 대부분 위험 | 파서가 본문을 건너뛰지 않는다. 더 엄격한 쪽이라 안전하다 |
| 세션 복제 | 언급 없음 | 복제한 세션은 `mcpEnabled` 를 끈다 | 권한이 사용자 모르게 복사되지 않게 한다 |

## Review Focus

1. **Claude Code 연결이 끊긴 요청**: 사용자가 확인 창 앞에서 고민하는 사이 Claude Code 연결이 끊기면, 나중에 허용해도 명령은 실행되지 않아야 한다 → Task 9 의 "클라이언트가 떠나면 핸들러에 취소가 전달된다" 테스트 + Task 8 의 "취소된 요청은 실행하지 않는다" 테스트.
2. **이름이 같은 세션**: `session` 인자로 이름을 넘겼는데 같은 이름의 허용 세션이 둘이면, 아무 쪽이나 고르지 말고 거부해야 한다 → Task 8 테스트.
3. **경로에 공백·작은따옴표·한글·`~`**: `cd` 와 이후 명령이 깨지거나 다른 명령으로 해석되면 안 된다 → Task 2 `shellQuote`/`quoteCdTarget` 테스트, Task 7 `cd` 테스트.
4. **바이너리·비 UTF-8·아주 긴 출력** (`cat` 으로 바이너리를 읽는 경우): 64KB 에서 자르고, 깨진 바이트는 대체 문자로 바꾸고, 앱이 멈추지 않아야 한다 → Task 7 테스트.
5. **확인 대기 중 앱 잠금**: 잠금 순간 대기 중인 확인 요청은 취소되고, 잠긴 뒤에는 어떤 명령도 실행되지 않아야 한다 → Task 6 `cancelAll` 테스트, Task 8 "확인 중에 잠기면 실행하지 않는다" 테스트.

---

## 파일 구조

| 파일 | 상태 | 책임 |
|---|---|---|
| `src/mcp/sdk.js` | 생성 | Web Crypto 보강 후 SDK·zod 를 불러와 내보냄 |
| `src/mcp/shellQuote.js` | 생성 | 셸 단어 인용, `cd` 대상 인용(`~` 유지) |
| `src/mcp/shellParse.js` | 생성 | 명령 문자열 → 명령 조각·리다이렉션·치환 목록 |
| `src/mcp/commandRules.js` | 생성 | 명령별 위험도 규칙 표 |
| `src/mcp/commandPolicy.js` | 생성 | 위험도 판정(`classifyCommand`), 확인 필요 여부(`needsApproval`) |
| `src/mcp/auditLog.js` | 생성 | 줄 단위 JSON 감사 로그, 5MB 교체, 최근 기록 읽기 |
| `src/mcp/mcpConfig.js` | 생성 | `mcp.json` 읽기·검증·저장, 토큰 발급 |
| `src/mcp/approval.js` | 생성 | 확인 요청 큐, 60초 만료, 취소 |
| `src/mcp/sessionGateway.js` | 생성 | 세션별 SSH 연결 재사용, 실행, 작업 디렉터리 |
| `src/mcp/tools.js` | 생성 | `list_sessions` / `cd` / `run_command` 처리 흐름 |
| `src/mcp/server.js` | 생성 | HTTP 서버, 토큰·Host·Origin 검사, MCP 도구 등록 |
| `src/mcp/controller.js` | 생성 | 모듈 조립, 서버 시작/중지, 잠금 처리 |
| `src/mcp/ipc.js` | 생성 | 렌더러용 IPC 핸들러 |
| `src/sshConnectionTest.js` | 수정 | `buildOptions` 내보내기 추가 |
| `main.js` | 수정 | 컨트롤러 생성, 세션 복호화 함수 분리, 잠금·저장·종료 연결, 확인 창 알림 |
| `src/preload.js` | 수정 | MCP IPC API |
| `electron.vite.config.ts` | 수정 | `src/mcp` 복사 |
| `package.json` | 수정 | 의존성 2개 |
| `src/renderer/types/index.ts` | 수정 | MCP 타입, `electronAPI` 멤버 |
| `src/renderer/lib/mcpLabels.ts` | 생성 | 위험도·결과 라벨, 토큰 가림, 포트 검사, 남은 시간 |
| `src/renderer/components/Mcp/McpSettings.tsx` | 생성 | 설정 > MCP 탭 |
| `src/renderer/components/Mcp/McpAuditList.tsx` | 생성 | 감사 로그 표 |
| `src/renderer/components/Mcp/McpApprovalDialog.tsx` | 생성 | 확인 창 |
| `src/renderer/components/Mcp/Mcp.css` | 생성 | MCP 화면 공통 스타일 |
| `src/renderer/components/Settings/SettingsModal.tsx` | 수정 | MCP 탭 추가 |
| `src/renderer/components/Modal/ConnectModal.tsx` | 수정 | "MCP 접근 허용" 스위치 |
| `src/renderer/stores/sessionStore.ts` | 수정 | `Session.mcpEnabled` |
| `src/renderer/App.tsx` | 수정 | 세션 저장 매핑, 복제 시 끄기, 확인 창 마운트 |
| `CLAUDE.md` | 수정 | MCP 구조 설명 |

---

### Task 1: SDK 의존성과 로더, 빌드 복사

**Files:**
- Modify: `package.json` (dependencies)
- Create: `src/mcp/sdk.js`
- Modify: `electron.vite.config.ts`
- Test: `src/mcp/sdk.test.js`

**Interfaces:**
- Produces: `require('./sdk.js')` → `{ McpServer, StreamableHTTPServerTransport, z }`. 다른 `src/mcp` 모듈은 SDK 를 직접 `require` 하지 않고 이 파일을 통한다.

- [ ] **Step 1: 의존성 설치**

사용자가 dev 모드 앱을 쓰는 중이면 먼저 알린다 (새 패키지는 앱 재시작 후 반영).

```bash
npm install --save @modelcontextprotocol/sdk@1.31.0 zod@3
```

`package.json` 의 `dependencies` 에 `"@modelcontextprotocol/sdk": "1.31.0"`(정확한 버전)과 `"zod": "^3.x"` 가 들어갔는지 확인한다. `^1.31.0` 으로 들어갔으면 `1.31.0` 으로 고친다.

- [ ] **Step 2: 실패하는 테스트 작성** — `src/mcp/sdk.test.js`

```js
import { describe, it, expect } from 'vitest'
import sdk from './sdk.js'

describe('sdk loader', () => {
  it('exposes the MCP server classes and zod', () => {
    expect(typeof sdk.McpServer).toBe('function')
    expect(typeof sdk.StreamableHTTPServerTransport).toBe('function')
    expect(typeof sdk.z.string).toBe('function')
  })

  it('makes Web Crypto available globally for the SDK', () => {
    expect(globalThis.crypto?.subtle).toBeDefined()
  })
})
```

- [ ] **Step 3: 실패 확인**

Run: `npx vitest run src/mcp/sdk.test.js`
Expected: FAIL (`Cannot find module './sdk.js'` 또는 이에 준하는 오류)

- [ ] **Step 4: 구현** — `src/mcp/sdk.js`

```js
// Single entry point for the MCP SDK in the main process.
// Electron 28 runs Node 18, where Web Crypto is not a global yet; the SDK expects it.
if (!globalThis.crypto) {
  globalThis.crypto = require('crypto').webcrypto
}

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js')
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js')
const { z } = require('zod')

module.exports = { McpServer, StreamableHTTPServerTransport, z }
```

- [ ] **Step 5: 통과 확인**

Run: `npx vitest run src/mcp/sdk.test.js`
Expected: PASS (2 tests)

- [ ] **Step 6: Electron 의 Node 로 로드 확인**

Run: `ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe -e "const s=require('./src/mcp/sdk.js'); console.log(process.versions.node, typeof s.McpServer, typeof globalThis.crypto.subtle)"`
Expected: `18.18.2 function object`

- [ ] **Step 7: 빌드 복사 추가** — `electron.vite.config.ts`

`MAIN_RUNTIME_MODULES` 선언 아래에 추가:

```ts
// Directories under src/ that main.js loads at runtime; copied whole, without their tests
const MAIN_RUNTIME_DIRECTORIES = ['mcp']
```

`copyCryptoPlugin` 의 `closeBundle()` 안, 기존 `for (const file of MAIN_RUNTIME_MODULES)` 반복문 뒤에 추가:

```ts
      for (const dir of MAIN_RUNTIME_DIRECTORIES) {
        fs.cpSync(path.resolve(__dirname, 'src', dir), path.resolve(__dirname, 'out/main/src', dir), {
          recursive: true,
          filter: (source) => !source.endsWith('.test.js')
        })
      }
```

- [ ] **Step 8: 빌드 확인**

Run: `npm run build && ls out/main/src/mcp`
Expected: 빌드 성공, `sdk.js` 는 있고 `sdk.test.js` 는 없다.

- [ ] **Step 9: 체크박스 갱신** (커밋은 사용자 요청 시)

---

### Task 2: 셸 인용과 명령 분해

**Files:**
- Create: `src/mcp/shellQuote.js`, `src/mcp/shellParse.js`
- Test: `src/mcp/shellQuote.test.js`, `src/mcp/shellParse.test.js`

**Interfaces:**
- Produces:
  - `shellQuote(value: string): string` — 한 단어로 인용 (`it's` → `'it'\''s'`)
  - `quoteCdTarget(target: string): string` — 앞의 `~`, `~/` 는 인용하지 않음
  - `parseCommand(input: string)` →
    `{ ok: true, segments: Array<{ words: string[], redirects: Array<{ op: string, fd: string, target: string }> }>, substitutions: string[], background: boolean, heredoc: boolean }`
    또는 `{ ok: false, error: string }`
    - `op` 값: `'>' '>>' '>|' '&>' '&>>' '<' '<<' '<<-' '<<<' '<>' 'dup'` (`2>&1` 같은 디스크립터 복제는 `'dup'`)

- [ ] **Step 1: 실패하는 테스트 작성** — `src/mcp/shellQuote.test.js`

```js
import { describe, it, expect } from 'vitest'
import quote from './shellQuote.js'

const { shellQuote, quoteCdTarget } = quote

describe('shellQuote', () => {
  it('wraps a value in single quotes', () => {
    expect(shellQuote('/var/log')).toBe("'/var/log'")
  })

  it('keeps spaces, Korean and shell operators inside one word', () => {
    expect(shellQuote('로그 폴더; rm x')).toBe("'로그 폴더; rm x'")
  })

  it('escapes single quotes', () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'")
  })

  it('quotes an empty value', () => {
    expect(shellQuote('')).toBe("''")
  })
})

describe('quoteCdTarget', () => {
  it('leaves a bare ~ for the shell to expand', () => {
    expect(quoteCdTarget('~')).toBe('~')
  })

  it('keeps ~/ unquoted and quotes the rest', () => {
    expect(quoteCdTarget("~/my app's logs")).toBe("~/'my app'\\''s logs'")
  })

  it('quotes other paths, including ~user', () => {
    expect(quoteCdTarget('/var/log')).toBe("'/var/log'")
    expect(quoteCdTarget('~user')).toBe("'~user'")
  })
})
```

- [ ] **Step 2: 실패하는 테스트 작성** — `src/mcp/shellParse.test.js`

```js
import { describe, it, expect } from 'vitest'
import parser from './shellParse.js'

const { parseCommand } = parser
const words = (input) => parseCommand(input).segments.map(segment => segment.words)

describe('parseCommand', () => {
  it('splits on ; && || | and newlines', () => {
    expect(words('ls -al; pwd && whoami || id | wc -l\nuptime'))
      .toEqual([['ls', '-al'], ['pwd'], ['whoami'], ['id'], ['wc', '-l'], ['uptime']])
  })

  it('removes quotes and escapes', () => {
    expect(words(`grep "a b" 'c;d' e\\ f r''m \\rm`)).toEqual([['grep', 'a b', 'c;d', 'e f', 'rm', 'rm']])
  })

  it('keeps operators inside quotes as text', () => {
    expect(words(`grep '|' file`)).toEqual([['grep', '|', 'file']])
  })

  it('collects command substitutions', () => {
    expect(parseCommand('echo $(rm -rf x) `id` "$(whoami)"').substitutions).toEqual(['rm -rf x', 'id', 'whoami'])
  })

  it('collects the outer text of nested substitutions', () => {
    expect(parseCommand('echo $(echo $(id))').substitutions).toEqual(['echo $(id)'])
  })

  it('collects process substitutions', () => {
    expect(parseCommand('diff <(ls a) <(ls b)').substitutions).toEqual(['ls a', 'ls b'])
  })

  it('parses redirects and descriptor duplication', () => {
    const [segment] = parseCommand('cat a > b 2>&1 < c').segments
    expect(segment.words).toEqual(['cat', 'a'])
    expect(segment.redirects).toEqual([
      { op: '>', fd: '', target: 'b' },
      { op: 'dup', fd: '2', target: '1' },
      { op: '<', fd: '', target: 'c' }
    ])
  })

  it('parses attached and &> redirects', () => {
    const [segment] = parseCommand('echo x>out &>log').segments
    expect(segment.words).toEqual(['echo', 'x'])
    expect(segment.redirects).toEqual([
      { op: '>', fd: '', target: 'out' },
      { op: '&>', fd: '', target: 'log' }
    ])
  })

  it('treats a quoted > as a plain word', () => {
    expect(parseCommand(`grep '>' f`).segments[0].redirects).toEqual([])
  })

  it('marks background jobs but not &&', () => {
    expect(parseCommand('sleep 10 &').background).toBe(true)
    expect(parseCommand('a && b').background).toBe(false)
  })

  it('marks heredocs', () => {
    expect(parseCommand('cat <<EOF\nhi\nEOF').heredoc).toBe(true)
  })

  it('ignores comments', () => {
    expect(words('ls # rm -rf /')).toEqual([['ls']])
    expect(words('echo a#b')).toEqual([['echo', 'a#b']])
  })

  it('splits subshell parentheses', () => {
    expect(words('(cd /tmp; rm x)')).toEqual([['cd', '/tmp'], ['rm', 'x']])
  })

  it('keeps ${VAR} as text', () => {
    expect(words('echo ${HOME}/x')).toEqual([['echo', '${HOME}/x']])
  })

  it('fails on input it cannot follow', () => {
    expect(parseCommand(`echo 'oops`).ok).toBe(false)
    expect(parseCommand('echo "oops').ok).toBe(false)
    expect(parseCommand('echo $(id').ok).toBe(false)
    expect(parseCommand('echo `id').ok).toBe(false)
    expect(parseCommand('ls >').ok).toBe(false)
  })
})
```

- [ ] **Step 3: 실패 확인**

Run: `npx vitest run src/mcp/shellQuote.test.js src/mcp/shellParse.test.js`
Expected: FAIL (모듈 없음)

- [ ] **Step 4: 구현** — `src/mcp/shellQuote.js`

```js
/** Quote a value as one POSIX shell word: it's -> 'it'\''s' */
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/** Like shellQuote, but a leading ~ or ~/ stays unquoted so the shell still expands it */
function quoteCdTarget(target) {
  if (target === '~') return '~'
  if (target.startsWith('~/')) return `~/${shellQuote(target.slice(2))}`
  return shellQuote(target)
}

module.exports = { shellQuote, quoteCdTarget }
```

- [ ] **Step 5: 구현** — `src/mcp/shellParse.js`

```js
// Splits a POSIX shell command line into simple commands for the MCP command policy.
// It is not a full shell: input it cannot follow is reported as a failure, and the
// policy treats a failed parse as dangerous.

const HEREDOC_OPS = new Set(['<<', '<<-'])
const REDIRECT_OPS = ['<<<', '<<-', '<<', '<&', '<>', '<', '>>', '>|', '>&', '>']
const DUP_TARGET = /^(\d+|-)$/

class ParseError extends Error {}

function skipDoubleQuoted(input, start) {
  for (let i = start; i < input.length; i++) {
    if (input[i] === '\\') { i++; continue }
    if (input[i] === '"') return i
  }
  return -1
}

/** Index of the `)` that closes a `$(` / `<(` whose content starts at `start`, or -1 */
function findClosingParen(input, start) {
  let depth = 1
  for (let i = start; i < input.length; i++) {
    const c = input[i]
    if (c === '\\') { i++; continue }
    if (c === "'") {
      const end = input.indexOf("'", i + 1)
      if (end === -1) return -1
      i = end
      continue
    }
    if (c === '"') {
      const end = skipDoubleQuoted(input, i + 1)
      if (end === -1) return -1
      i = end
      continue
    }
    if (c === '(') depth++
    else if (c === ')' && --depth === 0) return i
  }
  return -1
}

function findBacktick(input, start) {
  for (let i = start; i < input.length; i++) {
    if (input[i] === '\\') { i++; continue }
    if (input[i] === '`') return i
  }
  return -1
}

function tokenize(input) {
  const tokens = []
  const substitutions = []
  let word = ''
  let inWord = false
  let quoted = false

  const pushWord = () => {
    if (inWord) tokens.push({ type: 'word', text: word, quoted })
    word = ''
    inWord = false
    quoted = false
  }
  const addText = (text) => { word += text; inWord = true }

  /** `$(...)` or `<(...)` / `>(...)` starting at `i`; returns the index after `)` */
  const takeParenSubstitution = (i) => {
    const end = findClosingParen(input, i + 2)
    if (end === -1) throw new ParseError('닫히지 않은 괄호 치환')
    substitutions.push(input.slice(i + 2, end))
    addText(input.slice(i, end + 1))
    return end + 1
  }
  const takeBacktick = (i) => {
    const end = findBacktick(input, i + 1)
    if (end === -1) throw new ParseError('닫히지 않은 백틱')
    substitutions.push(input.slice(i + 1, end))
    addText(input.slice(i, end + 1))
    return end + 1
  }
  const takeDoubleQuoted = (start) => {
    for (let j = start; j < input.length;) {
      const c = input[j]
      if (c === '"') { quoted = true; inWord = true; return j + 1 }
      if (c === '\\') {
        const next = input[j + 1]
        if (next === '\n') { j += 2; continue }
        if ('$`"\\'.includes(next)) { addText(next); j += 2; continue }
        addText('\\')
        j++
        continue
      }
      if (c === '$' && input[j + 1] === '(') { j = takeParenSubstitution(j); continue }
      if (c === '`') { j = takeBacktick(j); continue }
      addText(c)
      j++
    }
    throw new ParseError('큰따옴표가 닫히지 않음')
  }

  let i = 0
  while (i < input.length) {
    const c = input[i]
    const next = input[i + 1]

    if (c === '\\') {
      if (next === '\n') { i += 2; continue }
      if (next === undefined) throw new ParseError('끝에 \\ 만 있음')
      addText(next)
      quoted = true
      i += 2
      continue
    }
    if (c === "'") {
      const end = input.indexOf("'", i + 1)
      if (end === -1) throw new ParseError('작은따옴표가 닫히지 않음')
      addText(input.slice(i + 1, end))
      quoted = true
      i = end + 1
      continue
    }
    if (c === '"') { i = takeDoubleQuoted(i + 1); continue }
    if (c === '$' && next === '(') { i = takeParenSubstitution(i); continue }
    if (c === '$' && next === '{') {
      const end = input.indexOf('}', i + 2)
      if (end === -1) throw new ParseError('닫히지 않은 ${')
      addText(input.slice(i, end + 1))
      i = end + 1
      continue
    }
    if (c === '`') { i = takeBacktick(i); continue }
    if ((c === '<' || c === '>') && next === '(' && !inWord) { i = takeParenSubstitution(i); continue }
    if (c === '#' && !inWord) {
      const end = input.indexOf('\n', i)
      i = end === -1 ? input.length : end
      continue
    }
    if (c === ' ' || c === '\t' || c === '\r') { pushWord(); i++; continue }
    if (c === '\n' || c === ';') { pushWord(); tokens.push({ type: 'op', text: ';' }); i++; continue }
    if (c === '&' && next === '>') {
      pushWord()
      const op = input[i + 2] === '>' ? '&>>' : '&>'
      tokens.push({ type: 'redir', op, fd: '' })
      i += op.length
      continue
    }
    if (c === '&' || c === '|') {
      pushWord()
      if (next === c) { tokens.push({ type: 'op', text: c + c }); i += 2; continue }
      if (c === '|' && next === '&') { tokens.push({ type: 'op', text: '|' }); i += 2; continue }
      tokens.push({ type: 'op', text: c })
      i++
      continue
    }
    if (c === '(' || c === ')') { pushWord(); tokens.push({ type: 'op', text: c }); i++; continue }
    if (c === '>' || c === '<') {
      const fd = inWord && !quoted && /^\d+$/.test(word) ? word : ''
      if (fd) { word = ''; inWord = false } else { pushWord() }
      const op = REDIRECT_OPS.find(candidate => input.startsWith(candidate, i))
      tokens.push({ type: 'redir', op, fd })
      i += op.length
      continue
    }
    addText(c)
    i++
  }
  pushWord()
  return { tokens, substitutions }
}

function parseCommand(input) {
  try {
    const { tokens, substitutions } = tokenize(String(input))
    const segments = []
    let current = { words: [], redirects: [] }
    let background = false
    let heredoc = false
    const flush = () => {
      if (current.words.length > 0 || current.redirects.length > 0) segments.push(current)
      current = { words: [], redirects: [] }
    }

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]
      if (token.type === 'word') { current.words.push(token.text); continue }
      if (token.type === 'op') {
        if (token.text === '&') background = true
        flush()
        continue
      }
      const target = tokens[i + 1]
      if (!target || target.type !== 'word') throw new ParseError(`${token.op} 뒤에 대상이 없음`)
      i++
      if (HEREDOC_OPS.has(token.op)) heredoc = true
      const isDup = (token.op === '>&' || token.op === '<&') && DUP_TARGET.test(target.text)
      const op = isDup ? 'dup' : token.op === '>&' ? '>' : token.op === '<&' ? '<' : token.op
      current.redirects.push({ op, fd: token.fd, target: target.text })
    }
    flush()
    return { ok: true, segments, substitutions, background, heredoc }
  } catch (err) {
    if (err instanceof ParseError) return { ok: false, error: err.message }
    throw err
  }
}

module.exports = { parseCommand }
```

- [ ] **Step 6: 통과 확인**

Run: `npx vitest run src/mcp/shellQuote.test.js src/mcp/shellParse.test.js`
Expected: PASS (shellQuote 7 tests, shellParse 15 tests)

- [ ] **Step 7: 체크박스 갱신**

---

### Task 3: 명령 위험도 판정

**Files:**
- Create: `src/mcp/commandRules.js`, `src/mcp/commandPolicy.js`
- Test: `src/mcp/commandPolicy.test.js`

**Interfaces:**
- Consumes: `parseCommand` (Task 2)
- Produces:
  - `classifyCommand(input: string): { level: 'low'|'medium'|'danger'|'forbidden', reasons: string[] }` — `reasons` 는 높은 위험도의 근거부터, 예: `'rm: 파일 삭제'`
  - `needsApproval(level, alertLevel: 'all'|'medium'|'danger'): boolean` — `forbidden` 은 항상 `false`(따로 차단), 알 수 없는 `alertLevel` 은 `'all'` 처럼 취급
  - `LEVEL_ORDER = ['low', 'medium', 'danger', 'forbidden']`

- [ ] **Step 1: 실패하는 테스트 작성** — `src/mcp/commandPolicy.test.js`

```js
import { describe, it, expect } from 'vitest'
import policy from './commandPolicy.js'

const { classifyCommand, needsApproval } = policy
const level = (command) => classifyCommand(command).level

describe('classifyCommand: low', () => {
  it.each([
    'ls -al', 'cd /var/log', 'pwd', 'cat /var/log/app.log', 'tail -n 200 app.log',
    'grep -i error app.log | tail -n 20', 'ps aux | grep java', 'df -h', 'free -m', 'du -sh /var/log',
    'systemctl status tomcat', 'journalctl -u nginx --since today', 'docker ps -a', 'docker logs --tail 100 web',
    'kubectl get pods -n prod', 'git log --oneline -5', 'git branch -a', 'tar -tzf backup.tar.gz', 'crontab -l',
    'find /var/log -name "*.log" -mtime -1', 'top -b -n 1', 'ls 2>&1', 'ls > /dev/null', 'grep "a;b" file',
    '/usr/bin/ls -al', 'echo hello', 'FOO=1 ls', 'ip addr', 'timeout 5 tail -n 10 x', 'nohup ls', 'xargs'
  ])('%s', (command) => {
    expect(level(command)).toBe('low')
  })
})

describe('classifyCommand: medium', () => {
  it.each([
    'cat .env', 'cat /app/config/application-prod.yml', 'grep password ~/.ssh/config', 'env', 'printenv',
    'find / -name x', 'grep -r foo /', 'du -sh /', 'tail -f app.log', 'journalctl -f', 'docker logs -f web',
    'curl http://localhost:8080/health', "awk '{print $1}' access.log", 'sed -n 1,10p app.log', 'top',
    'watch df -h', 'kubectl config view', 'docker stats'
  ])('%s', (command) => {
    expect(level(command)).toBe('medium')
  })
})

describe('classifyCommand: danger', () => {
  it.each([
    'rm app.log', 'rm -rf /tmp/build', 'mv a b', 'cp a b', 'chmod 755 x', 'kill 1234', 'systemctl restart tomcat',
    'service nginx reload', 'docker restart web', 'docker exec -it web bash', 'kubectl delete pod x', 'sudo ls', 'su -',
    'apt install vim', 'pip install x', 'bash -c "ls"', 'sh script.sh', 'python3 x.py', './deploy.sh', 'ssh other',
    'scp a b:', 'mysql -u root', 'redis-cli FLUSHALL', 'vi app.conf', 'sed -i s/a/b/ f', 'echo x > file',
    'echo x >> file', 'cat a | tee b', 'ls &', 'find . -name "*.tmp" -delete', 'find . -exec rm {} \\;',
    'tar -xzf a.tar.gz', 'git pull', 'git checkout -- .', 'crontab -e', 'curl -o x http://a', 'curl -X POST http://a',
    'wget http://a', 'pm2 restart all', 'supervisorctl stop app', 'ls; rm x', 'ls && rm x', 'ls || rm x',
    'ls | xargs rm', 'echo $(rm x)', 'echo `rm x`', '/bin/rm x', '\\rm x', "r''m x", 'FOO=1 rm x', 'env rm x',
    'nice -n 10 rm x', 'timeout 5 rm x', 'unknowncmd', 'echo "unterminated', `awk 'BEGIN{system("rm x")}'`,
    'ls\nrm x', '(rm x)', 'diff <(rm x) y', 'cat <<EOF\nhi\nEOF'
  ])('%s', (command) => {
    expect(level(command)).toBe('danger')
  })
})

describe('classifyCommand: forbidden', () => {
  it.each([
    'rm -rf /', 'rm -rf /*', 'sudo rm -rf /', 'rm -fr ~', 'rm -rf $HOME', 'rm -r --no-preserve-root /x',
    'mkfs.ext4 /dev/sdb1', 'dd if=/dev/zero of=/dev/sda', 'echo x > /dev/sda', 'shutdown -h now', 'reboot',
    'sudo reboot', 'systemctl reboot', 'init 0', ':(){ :|:& };:', 'chmod -R 777 /', 'chown -R nobody /',
    'ls; rm -rf /'
  ])('%s', (command) => {
    expect(level(command)).toBe('forbidden')
  })
})

describe('classifyCommand: reasons', () => {
  it('names the command and why', () => {
    expect(classifyCommand('rm x').reasons).toContain('rm: 파일 삭제')
  })

  it('marks unknown commands', () => {
    expect(classifyCommand('pm3 restart').reasons).toContain('pm3: 처음 보는 명령')
  })

  it('lists the highest risk first', () => {
    const { reasons } = classifyCommand('cat .env; rm x')
    expect(reasons[0]).toBe('rm: 파일 삭제')
  })

  it('has no reasons for plain reads', () => {
    expect(classifyCommand('ls -al').reasons).toEqual([])
  })

  it('treats empty input as dangerous', () => {
    expect(level('   ')).toBe('danger')
  })
})

describe('needsApproval', () => {
  it.each([
    ['low', 'danger', false], ['medium', 'danger', false], ['danger', 'danger', true],
    ['low', 'medium', false], ['medium', 'medium', true], ['danger', 'medium', true],
    ['low', 'all', true], ['medium', 'all', true], ['danger', 'all', true],
    ['forbidden', 'all', false], ['forbidden', 'danger', false], ['low', 'bogus', true]
  ])('needsApproval(%s, %s) = %s', (riskLevel, alertLevel, expected) => {
    expect(needsApproval(riskLevel, alertLevel)).toBe(expected)
  })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/mcp/commandPolicy.test.js`
Expected: FAIL (모듈 없음)

- [ ] **Step 3: 구현** — `src/mcp/commandRules.js`

```js
// Per-command rules for the MCP command policy. A rule receives the words after the
// command name and returns a finding: { level, reason? }. Unknown commands are dangerous.

const LOW = 'low'
const MEDIUM = 'medium'
const DANGER = 'danger'
const FORBIDDEN = 'forbidden'

const low = () => ({ level: LOW })
const medium = (reason) => ({ level: MEDIUM, reason })
const danger = (reason) => ({ level: DANGER, reason })
const forbidden = (reason) => ({ level: FORBIDDEN, reason })

const LOW_COMMANDS = new Set([
  'ls', 'll', 'dir', 'cd', 'pwd', 'cat', 'head', 'less', 'more', 'grep', 'egrep', 'fgrep', 'zgrep', 'rg', 'wc',
  'sort', 'uniq', 'cut', 'tr', 'jq', 'yq', 'diff', 'cmp', 'stat', 'file', 'tree', 'df', 'free', 'uptime', 'uname',
  'hostname', 'whoami', 'id', 'groups', 'date', 'cal', 'ps', 'pgrep', 'pidof', 'lsof', 'vmstat', 'iostat', 'mpstat',
  'netstat', 'ss', 'which', 'whereis', 'type', 'echo', 'printf', 'basename', 'dirname', 'realpath', 'readlink',
  'md5sum', 'sha1sum', 'sha256sum', 'zcat', 'zless', 'bzcat', 'xzcat', 'nproc', 'lscpu', 'lsblk', 'lsmem', 'w', 'who',
  'last', 'lastlog', 'true', 'false', 'test', '[', 'sleep', 'column', 'nl', 'fold', 'rev', 'tac', 'strings', 'od',
  'hexdump', 'xxd', 'getent', 'locale', 'arch', 'dmesg', 'timedatectl', 'hostnamectl'
])

const DANGER_GROUPS = {
  '파일 변경': ['rmdir', 'mv', 'cp', 'ln', 'touch', 'mkdir', 'truncate', 'tee', 'install', 'shred', 'unlink', 'rename'],
  '프로세스·서비스 변경': ['kill', 'pkill', 'killall', 'service', 'pm2', 'supervisorctl'],
  '패키지 설치·변경': ['apt', 'apt-get', 'yum', 'dnf', 'apk', 'pip', 'pip3', 'npm', 'npx', 'yarn', 'pnpm', 'gem'],
  '임의 코드 실행': ['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'python', 'python2', 'python3', 'perl', 'ruby', 'node',
    'php', 'lua', 'eval', 'source', '.'],
  '원격 접속·전송': ['ssh', 'scp', 'sftp', 'rsync', 'nc', 'ncat', 'netcat', 'telnet', 'ftp'],
  'DB 클라이언트(데이터 변경 가능)': ['mysql', 'mariadb', 'psql', 'redis-cli', 'mongo', 'mongosh', 'sqlite3'],
  '대화형 편집기': ['vi', 'vim', 'nvim', 'nano', 'emacs'],
  '파일 다운로드': ['wget'],
  '시스템 설정 변경': ['mount', 'umount', 'iptables', 'ip6tables', 'nft', 'ufw', 'firewall-cmd', 'sysctl', 'modprobe',
    'swapoff', 'swapon'],
  '계정 변경': ['useradd', 'userdel', 'usermod', 'groupadd', 'groupdel', 'passwd', 'chpasswd'],
  '예약 작업 변경': ['at', 'batch']
}
const DANGER_REASONS = new Map(
  Object.entries(DANGER_GROUPS).flatMap(([reason, names]) => names.map(name => [name, reason]))
)

const FORBIDDEN_COMMANDS = new Map([
  ['shutdown', '시스템 종료'], ['reboot', '시스템 재부팅'], ['halt', '시스템 정지'], ['poweroff', '시스템 종료'],
  ['mke2fs', '파일시스템 포맷']
])

const ROOT_TARGETS = new Set(['/', '/*', '/.', '//', '~', '~/', '~/*', '$HOME', '$HOME/', '$HOME/*', '${HOME}'])

/** True when any option word sets one of `shortLetters` or matches one of `longNames` */
function hasFlag(args, shortLetters, longNames = []) {
  return args.some(arg => {
    if (arg.startsWith('--')) return longNames.some(name => arg === name || arg.startsWith(`${name}=`))
    return arg.startsWith('-') && arg.length > 1 && [...arg.slice(1)].some(ch => shortLetters.includes(ch))
  })
}

const positional = (args) => args.filter(arg => !arg.startsWith('-'))
const followCheck = (args, label) => (hasFlag(args, 'f', ['--follow']) ? medium(`${label} -f: 끝나지 않는 명령`) : low())

const FIND_DANGER_ACTIONS = new Set(['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls'])
function findRule(args) {
  if (args.some(arg => FIND_DANGER_ACTIONS.has(arg))) return danger('find: 실행·삭제 옵션')
  const paths = []
  for (const arg of args) {
    if (arg.startsWith('-') || arg === '(' || arg === '!') break
    paths.push(arg)
  }
  return paths.includes('/') ? medium('find: 루트 전체 탐색') : low()
}

function grepRule(args, name) {
  const recursive = name === 'rg' || hasFlag(args, 'rR', ['--recursive', '--dereference-recursive'])
  return recursive && positional(args).includes('/') ? medium(`${name}: 루트 전체 검색`) : low()
}

function awkRule(args, name) {
  const program = positional(args)[0] || ''
  if (/system\s*\(|\|\s*getline|print[^;}]*>/.test(program)) return danger(`${name}: 프로그램 안에서 명령 실행·파일 쓰기`)
  return medium(`${name}: 프로그램 안에서 명령을 실행할 수 있음`)
}

const CURL_WRITE_LONG = ['--output', '--remote-name', '--remote-name-all', '--upload-file', '--data', '--data-raw',
  '--data-binary', '--data-urlencode', '--form', '--json', '--output-dir']
function requestMethod(args) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '-X' || arg === '--request') return args[i + 1] || ''
    if (arg.startsWith('--request=')) return arg.slice('--request='.length)
    if (/^-X./.test(arg)) return arg.slice(2)
  }
  return null
}
function curlRule(args) {
  if (hasFlag(args, 'oOTdF', CURL_WRITE_LONG)) return danger('curl: 파일 저장·데이터 전송')
  const method = requestMethod(args)
  if (method !== null && !['GET', 'HEAD'].includes(method.toUpperCase())) return danger(`curl: ${method} 요청`)
  return medium('curl: 외부로 요청')
}

const SYSTEMCTL_READ = new Set(['status', 'is-active', 'is-enabled', 'is-failed', 'list-units', 'list-unit-files',
  'list-timers', 'list-sockets', 'list-dependencies', 'show', 'cat'])
const SYSTEMCTL_FORBIDDEN = new Set(['reboot', 'poweroff', 'halt', 'kexec', 'emergency', 'rescue'])
function systemctlRule(args) {
  const sub = positional(args)[0]
  if (!sub || SYSTEMCTL_READ.has(sub)) return low()
  if (SYSTEMCTL_FORBIDDEN.has(sub)) return forbidden(`systemctl ${sub}: 시스템 종료·재부팅`)
  return danger(`systemctl ${sub}: 서비스 상태 변경`)
}

function journalctlRule(args) {
  if (hasFlag(args, 'f', ['--follow'])) return medium('journalctl -f: 끝나지 않는 명령')
  if (args.some(arg => /^--(vacuum|rotate|flush|relinquish|sync)/.test(arg))) return danger('journalctl: 로그 정리·회전')
  return low()
}

const COMPOSE_READ = new Set(['ps', 'logs', 'config', 'images', 'top', 'ls', 'version'])
function composeRule(args) {
  const sub = positional(args)[0]
  if (COMPOSE_READ.has(sub)) return followCheck(args, `docker compose ${sub}`)
  return danger(`docker compose ${sub || ''}: 컨테이너 변경`.trim())
}

const DOCKER_READ = new Set(['ps', 'logs', 'images', 'inspect', 'stats', 'top', 'version', 'info', 'port', 'history', 'diff'])
const DOCKER_OBJECTS = new Set(['container', 'image', 'volume', 'network', 'node', 'service'])
const DOCKER_OBJECT_READ = new Set(['ls', 'list', 'ps', 'inspect', 'logs', 'top', 'port', 'history'])
function dockerRule(args) {
  const [sub, sub2] = positional(args)
  if (sub === 'compose') return composeRule(args.slice(args.indexOf('compose') + 1))
  if (DOCKER_OBJECTS.has(sub)) {
    return DOCKER_OBJECT_READ.has(sub2) ? followCheck(args, `docker ${sub} ${sub2}`) : danger(`docker ${sub} ${sub2 || ''}: 컨테이너·이미지 변경`.trim())
  }
  if (sub === 'stats' && !args.includes('--no-stream')) return medium('docker stats: 끝나지 않는 명령 (--no-stream 필요)')
  if (DOCKER_READ.has(sub)) return followCheck(args, `docker ${sub}`)
  return danger(`docker ${sub || ''}: 컨테이너·이미지 변경`.trim())
}

const KUBECTL_READ = new Set(['get', 'describe', 'logs', 'top', 'version', 'explain', 'api-resources', 'api-versions', 'cluster-info'])
function kubectlRule(args) {
  const [sub, sub2] = positional(args)
  if (sub === 'config') {
    if (sub2 === 'view') return medium('kubectl config view: 인증 정보 포함 가능')
    if (sub2 === 'get-contexts' || sub2 === 'current-context') return low()
  }
  if (KUBECTL_READ.has(sub)) return followCheck(args, `kubectl ${sub}`)
  return danger(`kubectl ${sub || ''}: 클러스터 변경`.trim())
}

const GIT_READ = new Set(['log', 'status', 'diff', 'show', 'blame', 'ls-files', 'ls-tree', 'rev-parse', 'describe', 'shortlog', 'grep', 'cat-file'])
function gitRule(args) {
  const sub = positional(args)[0]
  if (GIT_READ.has(sub)) return low()
  const rest = sub ? args.slice(args.indexOf(sub) + 1) : []
  const readOnlyListing = positional(rest).length === 0 && !hasFlag(rest, 'dDmMcCf', ['--delete', '--move', '--copy', '--force'])
  if ((sub === 'branch' || sub === 'tag') && readOnlyListing) return low()
  if (sub === 'remote' && rest.every(arg => arg === '-v' || arg === '--verbose')) return low()
  if (sub === 'stash' && ['list', 'show'].includes(positional(rest)[0])) return low()
  if (sub === 'config' && hasFlag(rest, 'l', ['--list', '--get', '--get-all', '--get-regexp'])) return low()
  return danger(`git ${sub || ''}: 저장소 변경`.trim())
}

const TAR_WRITE_LONG = ['--create', '--extract', '--get', '--append', '--update', '--delete', '--concatenate']
function tarRule(args) {
  if (args.some(arg => TAR_WRITE_LONG.includes(arg))) return danger('tar: 묶기·풀기')
  if (args.includes('--list')) return low()
  const first = args[0] || ''
  const letters = first.startsWith('--') ? '' : first.replace(/^-/, '')
  return /t/.test(letters) && !/[cxurA]/.test(letters) ? low() : danger('tar: 묶기·풀기')
}

const IP_MUTATIONS = new Set(['add', 'del', 'delete', 'set', 'flush', 'change', 'replace', 'append', 'prepend'])

function rmRule(args) {
  const recursiveOrForce = hasFlag(args, 'rRf', ['--recursive', '--force'])
  if (args.includes('--no-preserve-root') || (recursiveOrForce && positional(args).some(arg => ROOT_TARGETS.has(arg)))) {
    return forbidden('rm: 루트·홈 전체 삭제')
  }
  return danger('rm: 파일 삭제')
}

function recursiveRootRule(args, name) {
  if (hasFlag(args, 'R', ['--recursive']) && positional(args).includes('/')) return forbidden(`${name} -R /: 전체 권한·소유자 변경`)
  return danger(`${name}: 권한·소유자 변경`)
}

function initRule(args, name) {
  return ['0', '6'].includes(args[0]) ? forbidden(`${name} ${args[0]}: 시스템 종료·재부팅`) : danger(`${name}: 실행 수준 변경`)
}

const RULES = {
  tail: (args) => (hasFlag(args, 'fF', ['--follow']) ? medium('tail -f: 끝나지 않는 명령') : low()),
  top: (args) => (hasFlag(args, 'b', ['--batch']) ? low() : medium('top: 대화형이라 끝나지 않음 (-b 필요)')),
  find: findRule,
  grep: grepRule,
  egrep: grepRule,
  fgrep: grepRule,
  zgrep: grepRule,
  rg: grepRule,
  du: (args) => (positional(args).includes('/') ? medium('du: 루트 전체 용량 계산') : low()),
  sed: (args) => (hasFlag(args, 'i', ['--in-place']) ? danger('sed -i: 파일 수정') : medium('sed: 내부 명령으로 파일 쓰기·실행 가능')),
  awk: awkRule,
  gawk: awkRule,
  mawk: awkRule,
  nawk: awkRule,
  curl: curlRule,
  systemctl: systemctlRule,
  journalctl: journalctlRule,
  docker: dockerRule,
  'docker-compose': composeRule,
  kubectl: kubectlRule,
  git: gitRule,
  tar: tarRule,
  crontab: (args) => (hasFlag(args, 'l') && !hasFlag(args, 'eri') ? low() : danger('crontab: 예약 작업 변경')),
  ip: (args) => (args.some(arg => IP_MUTATIONS.has(arg)) ? danger('ip: 네트워크 설정 변경') : low()),
  printenv: () => medium('printenv: 환경 변수 출력(비밀 정보 포함 가능)'),
  rm: rmRule,
  chmod: recursiveRootRule,
  chown: recursiveRootRule,
  chgrp: recursiveRootRule,
  dd: (args) => (args.some(arg => arg.startsWith('of=/dev/')) ? forbidden('dd: 디스크 장치에 직접 쓰기') : danger('dd: 디스크·파일 쓰기')),
  init: initRule,
  telinit: initRule
}

/**
 * Commands that run another command. `finding` is the wrapper's own risk, `valueOptions`
 * take the next word as their value, `whenEmpty` applies when no inner command follows.
 */
const WRAPPERS = {
  sudo: { finding: danger('sudo: 권한 상승'), valueOptions: ['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U', '--user', '--group'] },
  doas: { finding: danger('doas: 권한 상승'), valueOptions: ['-u', '-C'] },
  su: { finding: danger('su: 다른 계정으로 전환'), valueOptions: ['-c', '-s', '--command', '--shell'] },
  env: { finding: null, valueOptions: ['-u', '--unset', '-C', '--chdir', '-S'], whenEmpty: medium('env: 환경 변수 출력(비밀 정보 포함 가능)') },
  nohup: { finding: null, valueOptions: [] },
  timeout: { finding: null, valueOptions: ['-s', '--signal', '-k', '--kill-after'], skipPositional: 1 },
  nice: { finding: null, valueOptions: ['-n', '--adjustment'] },
  ionice: { finding: null, valueOptions: ['-c', '-n', '-p', '--class', '--classdata', '--pid'] },
  time: { finding: null, valueOptions: ['-f', '-o', '--format', '--output'] },
  command: { finding: null, valueOptions: [] },
  exec: { finding: null, valueOptions: ['-a'] },
  stdbuf: { finding: null, valueOptions: ['-i', '-o', '-e'] },
  xargs: { finding: null, valueOptions: ['-I', '-n', '-P', '-d', '-L', '-s', '-E', '-a', '--max-args', '--max-procs', '--delimiter', '--arg-file'] },
  watch: { finding: medium('watch: 끝나지 않는 명령'), valueOptions: ['-n', '--interval'] }
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

/** Words of the command a wrapper runs, after its own options */
function stripWrapper(name, args) {
  const { valueOptions, skipPositional = 0 } = WRAPPERS[name]
  let i = 0
  while (i < args.length) {
    const arg = args[i]
    if (arg === '--') { i++; break }
    if (name === 'env' && ASSIGNMENT.test(arg)) { i++; continue }
    if (arg.startsWith('-')) { i += valueOptions.includes(arg) ? 2 : 1; continue }
    break
  }
  return args.slice(i + skipPositional)
}

module.exports = {
  LOW, MEDIUM, DANGER, FORBIDDEN, low, medium, danger, forbidden,
  LOW_COMMANDS, DANGER_REASONS, FORBIDDEN_COMMANDS, RULES, WRAPPERS, ASSIGNMENT, stripWrapper
}
```

- [ ] **Step 4: 구현** — `src/mcp/commandPolicy.js`

```js
// Decides how risky a shell command line is before the MCP server runs it.
// This guards against mistakes, not a determined attacker: when in doubt it errs high,
// and the approval dialog plus the audit log are the final safety net.
const { parseCommand } = require('./shellParse.js')
const rules = require('./commandRules.js')

const { LOW, MEDIUM, DANGER, FORBIDDEN, low, medium, danger, forbidden } = rules

const LEVEL_ORDER = [LOW, MEDIUM, DANGER, FORBIDDEN]
const ALERT_THRESHOLDS = { all: LOW, medium: MEDIUM, danger: DANGER }
const MAX_DEPTH = 5
const FORK_BOMB = /(\w+|:)\s*\(\s*\)\s*\{[^}]*\1\s*\|\s*&?\s*\1/
const WRITE_REDIRECTS = new Set(['>', '>>', '>|', '&>', '&>>'])
const DISK_DEVICE = /^\/dev\/(sd|hd|vd|xvd|nvme|mmcblk|disk)/
const SENSITIVE_PATHS = [
  /(^|\/)\.env(\.|$)/,
  /\.(pem|key|p12|pfx|jks|keystore)$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)/,
  /(^|\/)\.ssh(\/|$)/,
  /^\/etc\/(shadow|gshadow|sudoers)/,
  /(^|\/)\.pgpass$/,
  /(^|\/)\.my\.cnf$/,
  /(^|\/)application[^/]*\.(ya?ml|properties)$/,
  /credential/i,
  /secret/i
]

const rank = (level) => LEVEL_ORDER.indexOf(level)

function sensitiveFindings(values) {
  return values
    .filter(value => SENSITIVE_PATHS.some(pattern => pattern.test(value)))
    .map(value => medium(`비밀 정보가 있을 수 있는 경로: ${value}`))
}

function classifyName(name, args) {
  if (rules.FORBIDDEN_COMMANDS.has(name)) return forbidden(`${name}: ${rules.FORBIDDEN_COMMANDS.get(name)}`)
  if (name.startsWith('mkfs')) return forbidden(`${name}: 파일시스템 포맷`)
  if (rules.RULES[name]) return rules.RULES[name](args, name)
  if (rules.DANGER_REASONS.has(name)) return danger(`${name}: ${rules.DANGER_REASONS.get(name)}`)
  if (rules.LOW_COMMANDS.has(name)) return low()
  return danger(`${name}: 처음 보는 명령`)
}

function classifyWords(words) {
  let start = 0
  while (start < words.length && rules.ASSIGNMENT.test(words[start])) start++
  const [raw, ...args] = words.slice(start)
  if (raw === undefined) return [low()]

  const name = raw.split('/').pop()
  const findings = sensitiveFindings(args)
  if (/^\.{1,2}\//.test(raw)) findings.push(danger(`${raw}: 현재 위치의 파일 실행`))

  const wrapper = rules.WRAPPERS[name]
  if (wrapper) {
    if (wrapper.finding) findings.push(wrapper.finding)
    const inner = rules.stripWrapper(name, args)
    findings.push(...(inner.length > 0 ? classifyWords(inner) : [wrapper.whenEmpty || low()]))
    return findings
  }
  findings.push(classifyName(name, args))
  return findings
}

function classifyRedirect({ op, target }) {
  if (op === 'dup') return low()
  if (WRITE_REDIRECTS.has(op)) {
    if (target === '/dev/null') return low()
    if (DISK_DEVICE.test(target)) return forbidden(`디스크 장치에 직접 쓰기: ${target}`)
    return danger(`파일에 쓰기: ${op} ${target}`)
  }
  if (op === '<>') return danger(`파일을 읽기·쓰기로 열기: ${target}`)
  return sensitiveFindings([target])[0] || low()
}

function summarize(findings) {
  const level = findings.reduce((max, finding) => (rank(finding.level) > rank(max) ? finding.level : max), LOW)
  const reasons = findings
    .filter(finding => finding.reason)
    .sort((a, b) => rank(b.level) - rank(a.level))
    .map(finding => finding.reason)
  return { level, reasons: [...new Set(reasons)] }
}

function classifyCommand(input, depth = 0) {
  if (typeof input !== 'string' || input.trim() === '') return { level: DANGER, reasons: ['빈 명령'] }
  if (depth > MAX_DEPTH) return { level: DANGER, reasons: ['명령 치환이 너무 깊게 중첩됨'] }
  if (FORK_BOMB.test(input)) return { level: FORBIDDEN, reasons: ['포크 폭탄'] }

  const parsed = parseCommand(input)
  if (!parsed.ok) return { level: DANGER, reasons: [`명령을 해석할 수 없음: ${parsed.error}`] }

  const findings = []
  for (const segment of parsed.segments) {
    findings.push(...classifyWords(segment.words))
    findings.push(...segment.redirects.map(classifyRedirect))
  }
  if (parsed.background) findings.push(danger('백그라운드 실행(&): 시간 제한 뒤에도 서버에 남음'))
  if (parsed.heredoc) findings.push(medium('히어닥(<<)'))
  for (const substitution of parsed.substitutions) {
    const inner = classifyCommand(substitution, depth + 1)
    findings.push({
      level: inner.level,
      reason: inner.reasons.length > 0 ? `명령 치환 안: ${inner.reasons.join(', ')}` : undefined
    })
  }
  return summarize(findings)
}

function needsApproval(level, alertLevel) {
  if (level === FORBIDDEN) return false
  const threshold = ALERT_THRESHOLDS[alertLevel] || LOW
  return rank(level) >= rank(threshold)
}

module.exports = { classifyCommand, needsApproval, LEVEL_ORDER }
```

- [ ] **Step 5: 통과 확인**

Run: `npx vitest run src/mcp/commandPolicy.test.js`
Expected: PASS. 실패하는 사례가 있으면 테스트 기대값이 아니라 규칙을 고친다. 단, 기대값이 설계 문서 3장과 어긋난 경우에만 테스트를 고치고 그 이유를 이 문서에 적는다.

- [ ] **Step 6: 체크박스 갱신**

---

### Task 4: 감사 로그

**Files:**
- Create: `src/mcp/auditLog.js`
- Test: `src/mcp/auditLog.test.js`

**Interfaces:**
- Produces: `createAuditLog({ filePath, maxBytes?, fileSystem?, now? })` →
  - `append(entry: object): void` — 실패하면 예외를 던진다 (호출자는 실행을 거부해야 함)
  - `readRecent(limit = 200): object[]` — `phase === 'end'` 인 기록을 최신순으로
- 기록 형식 (Task 8 이 씀): `{ time, phase: 'start'|'end', requestId, sessionId, sessionName, command, level, reasons, outcome?, exitCode?, timedOut?, truncated?, error? }`
  - `outcome`: `'executed' | 'approved' | 'denied' | 'expired' | 'cancelled' | 'blocked' | 'failed'`

- [ ] **Step 1: 실패하는 테스트 작성** — `src/mcp/auditLog.test.js`

```js
import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import auditModule from './auditLog.js'

const { createAuditLog } = auditModule
const fixedNow = () => new Date('2026-10-01T01:02:03.000Z')

let dir
let filePath

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-audit-'))
  filePath = path.join(dir, 'mcp-audit.log')
})

const finish = (log, requestId) => {
  log.append({ phase: 'start', requestId, command: 'ls' })
  log.append({ phase: 'end', requestId, command: 'ls', outcome: 'executed' })
}

describe('createAuditLog', () => {
  it('appends one JSON line per entry with a timestamp', () => {
    const log = createAuditLog({ filePath, now: fixedNow })
    log.append({ phase: 'start', requestId: 'r1', command: 'ls' })
    const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0])).toEqual({ time: '2026-10-01T01:02:03.000Z', phase: 'start', requestId: 'r1', command: 'ls' })
  })

  it('returns finished requests newest first', () => {
    const log = createAuditLog({ filePath, now: fixedNow })
    finish(log, 'r1')
    finish(log, 'r2')
    expect(log.readRecent().map(entry => entry.requestId)).toEqual(['r2', 'r1'])
  })

  it('limits the number of returned entries', () => {
    const log = createAuditLog({ filePath, now: fixedNow })
    for (const id of ['r1', 'r2', 'r3', 'r4', 'r5']) finish(log, id)
    expect(log.readRecent(2).map(entry => entry.requestId)).toEqual(['r5', 'r4'])
  })

  it('rotates the file when it would grow past the limit', () => {
    const log = createAuditLog({ filePath, maxBytes: 200, now: fixedNow })
    for (const id of ['r1', 'r2', 'r3']) finish(log, id)
    expect(fs.existsSync(`${filePath}.1`)).toBe(true)
    expect(fs.statSync(filePath).size).toBeLessThanOrEqual(200)
  })

  it('reads across the rotated file', () => {
    const log = createAuditLog({ filePath, maxBytes: 200, now: fixedNow })
    for (const id of ['r1', 'r2', 'r3']) finish(log, id)
    expect(log.readRecent().map(entry => entry.requestId)).toContain('r2')
  })

  it('skips corrupted lines', () => {
    fs.writeFileSync(filePath, 'not json\n')
    const log = createAuditLog({ filePath, now: fixedNow })
    finish(log, 'r1')
    expect(log.readRecent().map(entry => entry.requestId)).toEqual(['r1'])
  })

  it('throws when the file cannot be written', () => {
    const log = createAuditLog({ filePath: path.join(dir, 'missing', 'x.log'), now: fixedNow })
    expect(() => log.append({ phase: 'start' })).toThrow()
  })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/mcp/auditLog.test.js`
Expected: FAIL (모듈 없음)

- [ ] **Step 3: 구현** — `src/mcp/auditLog.js`

```js
// Append-only JSON-lines log of every MCP request. Writing must succeed before a
// command runs; the caller refuses to execute when append() throws.
const fs = require('fs')

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024
const DEFAULT_LIMIT = 200

function createAuditLog({ filePath, maxBytes = DEFAULT_MAX_BYTES, fileSystem = fs, now = () => new Date() }) {
  const rotatedPath = `${filePath}.1`

  function rotateIfNeeded(incomingBytes) {
    let size
    try {
      size = fileSystem.statSync(filePath).size
    } catch {
      return
    }
    if (size + incomingBytes > maxBytes) fileSystem.renameSync(filePath, rotatedPath)
  }

  function append(entry) {
    const line = `${JSON.stringify({ time: now().toISOString(), ...entry })}\n`
    rotateIfNeeded(Buffer.byteLength(line))
    fileSystem.appendFileSync(filePath, line, 'utf8')
  }

  function readEntries(file) {
    let text
    try {
      text = fileSystem.readFileSync(file, 'utf8')
    } catch {
      return []
    }
    return text.split('\n').filter(Boolean).flatMap(line => {
      try {
        return [JSON.parse(line)]
      } catch {
        return []
      }
    })
  }

  function readRecent(limit = DEFAULT_LIMIT) {
    const entries = [...readEntries(rotatedPath), ...readEntries(filePath)]
    return entries.filter(entry => entry.phase === 'end').slice(-limit).reverse()
  }

  return { append, readRecent }
}

module.exports = { createAuditLog }
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run src/mcp/auditLog.test.js`
Expected: PASS (7 tests)

- [ ] **Step 5: 체크박스 갱신**

---

### Task 5: MCP 설정 저장소

**Files:**
- Create: `src/mcp/mcpConfig.js`
- Test: `src/mcp/mcpConfig.test.js`

**Interfaces:**
- Produces: `createMcpConfigStore({ filePath, fileSystem?, randomBytes? })` →
  - `get(): { enabled: boolean, port: number, alertLevel: 'all'|'medium'|'danger', token: string }`
  - `update(patch): McpConfig` — `enabled`, `port`, `alertLevel` 만 허용. 잘못된 값이면 한국어 메시지로 예외, 저장하지 않음
  - `regenerateToken(): McpConfig`
  - 상수 `DEFAULT_PORT = 47521`

- [ ] **Step 1: 실패하는 테스트 작성** — `src/mcp/mcpConfig.test.js`

```js
import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import configModule from './mcpConfig.js'

const { createMcpConfigStore } = configModule

let filePath
beforeEach(() => {
  filePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-config-')), 'mcp.json')
})

const bytesOf = (value) => () => Buffer.alloc(32, value)
const saved = () => JSON.parse(fs.readFileSync(filePath, 'utf8'))

describe('createMcpConfigStore', () => {
  it('creates safe defaults with a token and saves them', () => {
    const store = createMcpConfigStore({ filePath, randomBytes: bytesOf(1) })
    expect(store.get()).toEqual({ enabled: false, port: 47521, alertLevel: 'danger', token: '01'.repeat(32) })
    expect(saved().token).toBe('01'.repeat(32))
  })

  it('keeps valid stored values', () => {
    const stored = { enabled: true, port: 50000, alertLevel: 'all', token: 'ab'.repeat(32) }
    fs.writeFileSync(filePath, JSON.stringify(stored))
    expect(createMcpConfigStore({ filePath, randomBytes: bytesOf(1) }).get()).toEqual(stored)
  })

  it('repairs invalid stored values', () => {
    fs.writeFileSync(filePath, JSON.stringify({ enabled: 'yes', port: 80, alertLevel: 'loud', token: 'short' }))
    expect(createMcpConfigStore({ filePath, randomBytes: bytesOf(2) }).get())
      .toEqual({ enabled: false, port: 47521, alertLevel: 'danger', token: '02'.repeat(32) })
  })

  it('recovers from a corrupted file', () => {
    fs.writeFileSync(filePath, '{ not json')
    expect(createMcpConfigStore({ filePath, randomBytes: bytesOf(3) }).get().port).toBe(47521)
  })

  it('updates and persists valid changes', () => {
    const store = createMcpConfigStore({ filePath, randomBytes: bytesOf(1) })
    const next = store.update({ enabled: true, alertLevel: 'medium', port: 50001 })
    expect(next).toMatchObject({ enabled: true, alertLevel: 'medium', port: 50001 })
    expect(saved()).toMatchObject({ enabled: true, alertLevel: 'medium', port: 50001 })
  })

  it('rejects invalid changes without saving', () => {
    const store = createMcpConfigStore({ filePath, randomBytes: bytesOf(1) })
    expect(() => store.update({ port: 70000 })).toThrow('포트')
    expect(() => store.update({ port: 1023 })).toThrow('포트')
    expect(() => store.update({ alertLevel: 'loud' })).toThrow('알림 수준')
    expect(() => store.update({ enabled: 'yes' })).toThrow()
    expect(() => store.update({ token: 'x' })).toThrow('token')
    expect(saved()).toMatchObject({ enabled: false, port: 47521, alertLevel: 'danger' })
  })

  it('regenerates the token', () => {
    let calls = 0
    const store = createMcpConfigStore({ filePath, randomBytes: () => Buffer.alloc(32, ++calls) })
    const before = store.get().token
    const after = store.regenerateToken().token
    expect(after).not.toBe(before)
    expect(saved().token).toBe(after)
  })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/mcp/mcpConfig.test.js`
Expected: FAIL (모듈 없음)

- [ ] **Step 3: 구현** — `src/mcp/mcpConfig.js`

```js
// MCP settings in userData/mcp.json. Kept apart from settings.json because the renderer
// rewrites that whole file; only the main process touches this one.
const fs = require('fs')
const crypto = require('crypto')

const DEFAULT_PORT = 47521
const MIN_PORT = 1024
const MAX_PORT = 65535
const ALERT_LEVELS = ['all', 'medium', 'danger']
const DEFAULT_ALERT_LEVEL = 'danger'
const TOKEN_PATTERN = /^[0-9a-f]{64}$/

const isValidPort = (value) => Number.isInteger(value) && value >= MIN_PORT && value <= MAX_PORT

const UPDATABLE = {
  enabled: (value) => typeof value === 'boolean' || 'enabled 는 true 또는 false 여야 합니다.',
  port: (value) => isValidPort(value) || `포트는 ${MIN_PORT}~${MAX_PORT} 사이의 정수여야 합니다.`,
  alertLevel: (value) => ALERT_LEVELS.includes(value) || '알림 수준은 all, medium, danger 중 하나여야 합니다.'
}

function createMcpConfigStore({ filePath, fileSystem = fs, randomBytes = crypto.randomBytes }) {
  const newToken = () => randomBytes(32).toString('hex')

  function read() {
    try {
      const parsed = JSON.parse(fileSystem.readFileSync(filePath, 'utf8'))
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }

  function save(config) {
    fileSystem.writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf8')
  }

  function sanitize(raw) {
    return {
      enabled: raw.enabled === true,
      port: isValidPort(raw.port) ? raw.port : DEFAULT_PORT,
      alertLevel: ALERT_LEVELS.includes(raw.alertLevel) ? raw.alertLevel : DEFAULT_ALERT_LEVEL,
      token: typeof raw.token === 'string' && TOKEN_PATTERN.test(raw.token) ? raw.token : newToken()
    }
  }

  const stored = read()
  let current = sanitize(stored)
  if (JSON.stringify(current) !== JSON.stringify(stored)) save(current)

  function update(patch) {
    const changes = Object.entries(patch && typeof patch === 'object' ? patch : {})
    for (const [key, value] of changes) {
      const check = UPDATABLE[key]
      if (!check) throw new Error(`바꿀 수 없는 설정입니다: ${key}`)
      const verdict = check(value)
      if (verdict !== true) throw new Error(verdict)
    }
    current = { ...current, ...Object.fromEntries(changes) }
    save(current)
    return current
  }

  function regenerateToken() {
    current = { ...current, token: newToken() }
    save(current)
    return current
  }

  return { get: () => current, update, regenerateToken }
}

module.exports = { createMcpConfigStore, DEFAULT_PORT, ALERT_LEVELS }
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run src/mcp/mcpConfig.test.js`
Expected: PASS (7 tests)

- [ ] **Step 5: 체크박스 갱신**

---

### Task 6: 확인 요청 중계

**Files:**
- Create: `src/mcp/approval.js`
- Test: `src/mcp/approval.test.js`

**Interfaces:**
- Produces: `createApprovalBroker({ show, dismiss?, timeoutMs?, newId?, now? })` →
  - `request(details: object, { signal }?): Promise<'approved'|'denied'|'expired'|'cancelled'>`
  - `respond(id: string, approved: boolean): boolean` — 지금 표시 중인 요청에만 응답 가능
  - `cancelAll(): void` — 표시 중·대기 중 요청을 모두 `'cancelled'` 로
  - `pendingCount(): number`
- `show(request)` 에는 `{ id, ...details, expiresAt }` 가 넘어간다. 창을 띄울 수 없으면 `false` 를 돌려줘야 하고, 그러면 그 요청은 `'denied'`.
- `dismiss(id)` 는 만료·취소로 창을 닫아야 할 때 호출된다 (사용자가 응답한 경우에는 호출하지 않음).

- [ ] **Step 1: 실패하는 테스트 작성** — `src/mcp/approval.test.js`

```js
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import approvalModule from './approval.js'

const { createApprovalBroker } = approvalModule

function setup(overrides = {}) {
  const shown = []
  const dismissed = []
  let count = 0
  const broker = createApprovalBroker({
    show: (request) => { shown.push(request); return true },
    dismiss: (id) => dismissed.push(id),
    timeoutMs: 1000,
    newId: () => `a${++count}`,
    now: () => 0,
    ...overrides
  })
  return { broker, shown, dismissed }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('createApprovalBroker', () => {
  it('shows the request and resolves with the answer', async () => {
    const { broker, shown } = setup()
    const answer = broker.request({ command: 'rm x' })
    expect(shown).toEqual([{ id: 'a1', command: 'rm x', expiresAt: 1000 }])
    expect(broker.respond('a1', true)).toBe(true)
    await expect(answer).resolves.toBe('approved')
  })

  it('resolves a refusal as denied', async () => {
    const { broker } = setup()
    const answer = broker.request({})
    broker.respond('a1', false)
    await expect(answer).resolves.toBe('denied')
  })

  it('expires after the timeout and closes the dialog', async () => {
    const { broker, dismissed } = setup()
    const answer = broker.request({})
    vi.advanceTimersByTime(1000)
    await expect(answer).resolves.toBe('expired')
    expect(dismissed).toEqual(['a1'])
  })

  it('asks one request at a time', async () => {
    const { broker, shown } = setup()
    const first = broker.request({ command: 'a' })
    const second = broker.request({ command: 'b' })
    expect(shown.map(request => request.id)).toEqual(['a1'])
    broker.respond('a1', true)
    expect(shown.map(request => request.id)).toEqual(['a1', 'a2'])
    broker.respond('a2', false)
    await expect(first).resolves.toBe('approved')
    await expect(second).resolves.toBe('denied')
  })

  it('ignores answers for requests that are not on screen', () => {
    const { broker } = setup()
    broker.request({})
    broker.request({})
    expect(broker.respond('a2', true)).toBe(false)
    expect(broker.respond('nope', true)).toBe(false)
  })

  it('denies at once when the dialog cannot be shown', async () => {
    const { broker } = setup({ show: () => false })
    await expect(broker.request({})).resolves.toBe('denied')
  })

  it('cancels when the caller aborts', async () => {
    const { broker, dismissed } = setup()
    const controller = new AbortController()
    const answer = broker.request({}, { signal: controller.signal })
    controller.abort()
    await expect(answer).resolves.toBe('cancelled')
    expect(dismissed).toEqual(['a1'])
  })

  it('cancels a queued request without showing it', async () => {
    const { broker, shown } = setup()
    broker.request({})
    const controller = new AbortController()
    const queued = broker.request({}, { signal: controller.signal })
    controller.abort()
    await expect(queued).resolves.toBe('cancelled')
    broker.respond('a1', true)
    expect(shown).toHaveLength(1)
  })

  it('cancels everything on cancelAll', async () => {
    const { broker, shown, dismissed } = setup()
    const first = broker.request({})
    const second = broker.request({})
    broker.cancelAll()
    await expect(first).resolves.toBe('cancelled')
    await expect(second).resolves.toBe('cancelled')
    expect(dismissed).toEqual(['a1'])
    expect(shown).toHaveLength(1)
    expect(broker.pendingCount()).toBe(0)
  })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/mcp/approval.test.js`
Expected: FAIL (모듈 없음)

- [ ] **Step 3: 구현** — `src/mcp/approval.js`

```js
// Queue of "may Claude run this?" questions for the user. One dialog at a time;
// no answer within the timeout means no.
const crypto = require('crypto')

const DEFAULT_TIMEOUT_MS = 60 * 1000

function createApprovalBroker({ show, dismiss = () => {}, timeoutMs = DEFAULT_TIMEOUT_MS, newId = () => crypto.randomUUID(), now = () => Date.now() }) {
  const queue = []
  let active = null

  function finish(item, outcome) {
    if (item.signal && item.onAbort) item.signal.removeEventListener('abort', item.onAbort)
    item.resolve(outcome)
  }

  function closeActive(outcome, closeDialog) {
    if (!active) return
    const { item, timer } = active
    active = null
    clearTimeout(timer)
    if (closeDialog) dismiss(item.id)
    finish(item, outcome)
    showNext()
  }

  function showNext() {
    while (!active && queue.length > 0) {
      const item = queue.shift()
      if (item.signal && item.signal.aborted) { finish(item, 'cancelled'); continue }
      const delivered = show({ id: item.id, ...item.details, expiresAt: now() + timeoutMs })
      if (!delivered) { finish(item, 'denied'); continue }
      active = { item, timer: setTimeout(() => closeActive('expired', true), timeoutMs) }
    }
  }

  function cancel(id) {
    if (active && active.item.id === id) { closeActive('cancelled', true); return }
    const index = queue.findIndex(item => item.id === id)
    if (index >= 0) finish(queue.splice(index, 1)[0], 'cancelled')
  }

  function request(details, { signal } = {}) {
    return new Promise((resolve) => {
      const item = { id: newId(), details, resolve, signal, onAbort: null }
      if (signal) {
        if (signal.aborted) { resolve('cancelled'); return }
        item.onAbort = () => cancel(item.id)
        signal.addEventListener('abort', item.onAbort, { once: true })
      }
      queue.push(item)
      showNext()
    })
  }

  function respond(id, approved) {
    if (!active || active.item.id !== id) return false
    closeActive(approved ? 'approved' : 'denied', false)
    return true
  }

  function cancelAll() {
    const waiting = queue.splice(0, queue.length)
    if (active) {
      const { item, timer } = active
      active = null
      clearTimeout(timer)
      dismiss(item.id)
      finish(item, 'cancelled')
    }
    waiting.forEach(item => finish(item, 'cancelled'))
  }

  return { request, respond, cancelAll, pendingCount: () => queue.length + (active ? 1 : 0) }
}

module.exports = { createApprovalBroker }
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run src/mcp/approval.test.js`
Expected: PASS (9 tests)

- [ ] **Step 5: 체크박스 갱신**

---

### Task 7: 세션 게이트웨이 (SSH 실행)

**Files:**
- Modify: `src/sshConnectionTest.js` (마지막 줄 `module.exports`)
- Create: `src/mcp/sessionGateway.js`
- Test: `src/mcp/sessionGateway.test.js`

**Interfaces:**
- Consumes: `buildOptions(config, readFile)` → `{ target, jump, readyTimeout }` (기존 함수, 이번에 내보냄), `describeSshError(err)`, `shellQuote`, `quoteCdTarget` (Task 2)
- Produces: `createSessionGateway({ createClient?, readFile?, idleMs?, execTimeoutMs?, maxOutputBytes? })` →
  - `run(session, command, { signal }?): Promise<{ cwd, exitCode: number|null, signal: string|null, stdout, stderr, truncated, timedOut, cancelled }>`
  - `changeDirectory(session, target, { signal }?): Promise<{ cwd }>`
  - `getCwd(sessionId): string | null`
  - `close(sessionId)`, `closeAll()`
  - 실패 시 `GatewayError` (`userMessage` 에 한국어 원인)

- [ ] **Step 1: `buildOptions` 내보내기** — `src/sshConnectionTest.js` 마지막 줄

```js
module.exports = { describeSshError, testSshConnection, buildOptions };
```

Run: `npx vitest run src/sshConnectionTest.test.js`
Expected: PASS (기존 테스트 그대로)

- [ ] **Step 2: 실패하는 테스트 작성** — `src/mcp/sessionGateway.test.js`

```js
import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'events'
import gatewayModule from './sessionGateway.js'

const { createSessionGateway } = gatewayModule

const HOME = '/home/app'
const session = { id: 's1', name: 'dev', host: 'dev.example', port: 22, username: 'app', authType: 'password', password: 'pw' }

/** Fake ssh2 Client. `respond(command)` returns { stdout?, stderr?, code?, hang? }; `pwd` answers HOME by default. */
function fakeSsh({ respond = () => ({}), failWith } = {}) {
  const created = []
  const commands = []
  const streams = []
  const createClient = () => {
    const client = new EventEmitter()
    client.ended = false
    client.connect = (options) => {
      client.options = options
      setImmediate(() => (failWith ? client.emit('error', failWith) : client.emit('ready')))
    }
    client.end = () => { client.ended = true; client.emit('close') }
    client.forwardOut = (srcIp, srcPort, host, port, cb) => setImmediate(() => cb(null, { tunnelTo: `${host}:${port}` }))
    client.exec = (command, cb) => {
      commands.push(command)
      const stream = new EventEmitter()
      stream.stderr = new EventEmitter()
      stream.signals = []
      stream.signal = (name) => stream.signals.push(name)
      stream.close = () => setImmediate(() => stream.emit('close', null, 'KILL'))
      streams.push({ command, stream })
      const reply = command === 'pwd' ? { stdout: `${HOME}\n` } : respond(command)
      setImmediate(() => {
        cb(null, stream)
        if (reply.hang) return
        setImmediate(() => {
          if (reply.stdout) stream.emit('data', Buffer.isBuffer(reply.stdout) ? reply.stdout : Buffer.from(reply.stdout))
          if (reply.stderr) stream.stderr.emit('data', Buffer.from(reply.stderr))
          stream.emit('close', reply.code ?? 0, undefined)
        })
      })
    }
    created.push(client)
    return client
  }
  return { createClient, created, commands, streams }
}

describe('createSessionGateway', () => {
  it('starts in the home directory and runs the command there', async () => {
    const ssh = fakeSsh({ respond: () => ({ stdout: 'a\nb\n' }) })
    const gateway = createSessionGateway({ createClient: ssh.createClient })
    const result = await gateway.run(session, 'ls -al')
    expect(ssh.commands).toEqual(['pwd', "cd '/home/app' && ls -al"])
    expect(result).toMatchObject({ cwd: HOME, exitCode: 0, stdout: 'a\nb\n', stderr: '', truncated: false, timedOut: false })
    gateway.closeAll()
  })

  it('reuses one connection for several commands', async () => {
    const ssh = fakeSsh()
    const gateway = createSessionGateway({ createClient: ssh.createClient })
    await gateway.run(session, 'ls')
    await gateway.run(session, 'pwd')
    expect(ssh.created).toHaveLength(1)
    gateway.closeAll()
  })

  it('reports a non-zero exit code and stderr', async () => {
    const ssh = fakeSsh({ respond: () => ({ stderr: 'no such file\n', code: 2 }) })
    const gateway = createSessionGateway({ createClient: ssh.createClient })
    expect(await gateway.run(session, 'cat x')).toMatchObject({ exitCode: 2, stderr: 'no such file\n' })
    gateway.closeAll()
  })

  it('changes directory and uses it for later commands', async () => {
    const ssh = fakeSsh({ respond: (command) => (command.includes('cd --') ? { stdout: "/var/log/it's app\n" } : {}) })
    const gateway = createSessionGateway({ createClient: ssh.createClient })
    expect(await gateway.changeDirectory(session, "it's app")).toEqual({ cwd: "/var/log/it's app" })
    expect(ssh.commands[1]).toBe("cd '/home/app' && cd -- 'it'\\''s app' && pwd")
    await gateway.run(session, 'ls')
    expect(ssh.commands[2]).toBe("cd '/var/log/it'\\''s app' && ls")
    expect(gateway.getCwd('s1')).toBe("/var/log/it's app")
    gateway.closeAll()
  })

  it('keeps the directory when cd fails', async () => {
    const ssh = fakeSsh({ respond: () => ({ stderr: 'bash: cd: nope: No such file or directory\n', code: 1 }) })
    const gateway = createSessionGateway({ createClient: ssh.createClient })
    await expect(gateway.changeDirectory(session, 'nope')).rejects.toMatchObject({ userMessage: 'bash: cd: nope: No such file or directory' })
    expect(gateway.getCwd('s1')).toBe(HOME)
    gateway.closeAll()
  })

  it('cuts long output and marks it truncated', async () => {
    const ssh = fakeSsh({ respond: () => ({ stdout: 'x'.repeat(50) }) })
    const gateway = createSessionGateway({ createClient: ssh.createClient, maxOutputBytes: 10 })
    expect(await gateway.run(session, 'cat big')).toMatchObject({ stdout: 'x'.repeat(10), truncated: true })
    gateway.closeAll()
  })

  it('replaces invalid UTF-8 and strips terminal colors', async () => {
    const bytes = Buffer.concat([Buffer.from('\x1b[31m빨강\x1b[0m '), Buffer.from([0xff, 0xfe])])
    const ssh = fakeSsh({ respond: () => ({ stdout: bytes }) })
    const gateway = createSessionGateway({ createClient: ssh.createClient })
    expect((await gateway.run(session, 'cat bin')).stdout).toBe('빨강 \uFFFD\uFFFD')
    gateway.closeAll()
  })

  it('stops a command that runs too long', async () => {
    const ssh = fakeSsh({ respond: () => ({ hang: true }) })
    const gateway = createSessionGateway({ createClient: ssh.createClient, execTimeoutMs: 30 })
    const result = await gateway.run(session, 'sleep 100')
    expect(result).toMatchObject({ timedOut: true, exitCode: null })
    expect(ssh.streams.at(-1).stream.signals).toContain('KILL')
    gateway.closeAll()
  })

  it('runs commands of one session one after another', async () => {
    const ssh = fakeSsh({ respond: (command) => (command.endsWith('&& A') ? { hang: true } : {}) })
    const gateway = createSessionGateway({ createClient: ssh.createClient })
    const first = gateway.run(session, 'A')
    const second = gateway.run(session, 'B')
    await vi.waitFor(() => expect(ssh.commands).toContain("cd '/home/app' && A"))
    expect(ssh.commands).not.toContain("cd '/home/app' && B")
    ssh.streams.find(entry => entry.command.endsWith('&& A')).stream.emit('close', 0)
    await first
    await second
    expect(ssh.commands.at(-1)).toBe("cd '/home/app' && B")
    gateway.closeAll()
  })

  it('reports connection failures in Korean and reconnects next time', async () => {
    const failWith = Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:22'), { code: 'ECONNREFUSED' })
    const ssh = fakeSsh({ failWith })
    const gateway = createSessionGateway({ createClient: ssh.createClient })
    await expect(gateway.run(session, 'ls')).rejects.toMatchObject({ userMessage: '서버가 연결을 거부했습니다.' })
    await expect(gateway.run(session, 'ls')).rejects.toBeTruthy()
    expect(ssh.created).toHaveLength(2)
  })

  it('connects through a jump host', async () => {
    const ssh = fakeSsh()
    const gateway = createSessionGateway({ createClient: ssh.createClient })
    await gateway.run({ ...session, useJumpHost: true, jumpHost: 'bastion', jumpUsername: 'jump', jumpAuthType: 'password', jumpPassword: 'j' }, 'ls')
    expect(ssh.created).toHaveLength(2)
    expect(ssh.created[0].options.host).toBe('bastion')
    expect(ssh.created[1].options.sock).toEqual({ tunnelTo: 'dev.example:22' })
    gateway.closeAll()
  })

  it('closes idle connections', async () => {
    const ssh = fakeSsh()
    const gateway = createSessionGateway({ createClient: ssh.createClient, idleMs: 20 })
    await gateway.run(session, 'ls')
    await vi.waitFor(() => expect(ssh.created[0].ended).toBe(true))
    expect(gateway.getCwd('s1')).toBeNull()
  })

  it('reconnects after the server closes the connection', async () => {
    const ssh = fakeSsh()
    const gateway = createSessionGateway({ createClient: ssh.createClient })
    await gateway.run(session, 'ls')
    ssh.created[0].emit('close')
    await gateway.run(session, 'ls')
    expect(ssh.created).toHaveLength(2)
    gateway.closeAll()
  })

  it('does not start a command for a cancelled request', async () => {
    const ssh = fakeSsh()
    const gateway = createSessionGateway({ createClient: ssh.createClient })
    const controller = new AbortController()
    controller.abort()
    await expect(gateway.run(session, 'ls', { signal: controller.signal })).rejects.toMatchObject({ userMessage: '요청이 취소되었습니다.' })
    expect(ssh.commands).toEqual([])
  })
})
```

- [ ] **Step 3: 실패 확인**

Run: `npx vitest run src/mcp/sessionGateway.test.js`
Expected: FAIL (모듈 없음)

- [ ] **Step 4: 구현** — `src/mcp/sessionGateway.js`

```js
// SSH connections used by the MCP tools: one reusable connection per session, commands
// run one at a time per session, each from the working directory the gateway remembers.
const fs = require('fs')
const { Client } = require('ssh2')
const { buildOptions, describeSshError } = require('../sshConnectionTest.js')
const { shellQuote, quoteCdTarget } = require('./shellQuote.js')

const DEFAULT_IDLE_MS = 5 * 60 * 1000
const DEFAULT_EXEC_TIMEOUT_MS = 30 * 1000
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024
/** How long to wait for a stopped channel to report that it closed */
const CLOSE_GRACE_MS = 2000
const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]/g
const CANCELLED_MESSAGE = '요청이 취소되었습니다.'

class GatewayError extends Error {
  constructor(userMessage, detail) {
    super(userMessage)
    this.userMessage = userMessage
    this.detail = detail
  }
}

function createOutputBuffer(limit) {
  const chunks = []
  let size = 0
  let truncated = false
  return {
    push(chunk) {
      if (size >= limit) { truncated = true; return }
      const piece = chunk.length > limit - size ? chunk.subarray(0, limit - size) : chunk
      if (piece.length < chunk.length) truncated = true
      chunks.push(piece)
      size += piece.length
    },
    text: () => Buffer.concat(chunks).toString('utf8').replace(ANSI_PATTERN, ''),
    isTruncated: () => truncated
  }
}

const endQuietly = (client) => {
  try { client.end() } catch { /* already closed */ }
}
const lastLine = (text) => text.trim().split('\n').pop().trim()

function createSessionGateway({
  createClient = () => new Client(),
  readFile = fs.readFileSync,
  idleMs = DEFAULT_IDLE_MS,
  execTimeoutMs = DEFAULT_EXEC_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES
} = {}) {
  const entries = new Map()

  function connect(session) {
    let options
    try {
      options = buildOptions(session, readFile)
    } catch (err) {
      return Promise.reject(new GatewayError(err.userMessage || '접속 정보를 읽지 못했습니다.', err.detail))
    }
    return new Promise((resolve, reject) => {
      const clients = []
      let settled = false
      const fail = (err) => {
        if (settled) return
        settled = true
        clients.forEach(endQuietly)
        reject(new GatewayError(describeSshError(err).error, err.message))
      }
      const connectTarget = (sock) => {
        const client = createClient()
        clients.push(client)
        client.on('ready', () => {
          if (settled) return
          settled = true
          resolve({ client, clients })
        })
        client.on('error', fail)
        client.connect(sock ? { ...options.target, sock } : options.target)
      }
      if (!options.jump) { connectTarget(null); return }
      const jump = createClient()
      clients.push(jump)
      jump.on('ready', () => {
        jump.forwardOut('127.0.0.1', 0, options.target.host, options.target.port, (err, stream) => (err ? fail(err) : connectTarget(stream)))
      })
      jump.on('error', fail)
      jump.connect(options.jump)
    })
  }

  function exec(client, command, signal) {
    return new Promise((resolve, reject) => {
      client.exec(command, (err, stream) => {
        if (err) { reject(new GatewayError('명령을 실행할 채널을 열지 못했습니다.', err.message)); return }
        const stdout = createOutputBuffer(maxOutputBytes)
        const stderr = createOutputBuffer(maxOutputBytes)
        let timedOut = false
        let cancelled = false
        let done = false
        let graceTimer = null
        let timer = null
        const finish = (code, signalName) => {
          if (done) return
          done = true
          clearTimeout(timer)
          clearTimeout(graceTimer)
          if (signal) signal.removeEventListener('abort', onAbort)
          resolve({
            exitCode: typeof code === 'number' ? code : null,
            signal: signalName || null,
            stdout: stdout.text(),
            stderr: stderr.text(),
            truncated: stdout.isTruncated() || stderr.isTruncated(),
            timedOut,
            cancelled
          })
        }
        const stop = () => {
          try { stream.signal('KILL') } catch { /* server may not support signals */ }
          try { stream.close() } catch { /* already closed */ }
          graceTimer = setTimeout(() => finish(null, null), CLOSE_GRACE_MS)
        }
        function onAbort() { cancelled = true; stop() }
        timer = setTimeout(() => { timedOut = true; stop() }, execTimeoutMs)
        if (signal) signal.addEventListener('abort', onAbort, { once: true })
        stream.on('data', (chunk) => stdout.push(chunk))
        stream.stderr.on('data', (chunk) => stderr.push(chunk))
        stream.on('close', (code, signalName) => finish(code, signalName))
        stream.on('error', () => finish(null, null))
      })
    })
  }

  function drop(sessionId, entry) {
    if (entries.get(sessionId) !== entry) return
    entries.delete(sessionId)
    clearTimeout(entry.idleTimer)
    entry.connection.then((conn) => conn.clients.forEach(endQuietly), () => {})
  }

  function getEntry(session) {
    const existing = entries.get(session.id)
    if (existing) return existing
    const entry = { cwd: null, idleTimer: null, queue: Promise.resolve(), connection: null }
    entry.connection = connect(session).then((conn) => {
      conn.client.on('close', () => drop(session.id, entry))
      conn.client.on('error', () => drop(session.id, entry))
      return conn
    })
    entry.connection.catch(() => drop(session.id, entry))
    entries.set(session.id, entry)
    return entry
  }

  function touch(sessionId, entry) {
    clearTimeout(entry.idleTimer)
    entry.idleTimer = setTimeout(() => drop(sessionId, entry), idleMs)
  }

  function serialize(entry, task) {
    const result = entry.queue.then(task)
    entry.queue = result.catch(() => {})
    return result
  }

  async function prepare(session, entry, signal) {
    if (signal && signal.aborted) throw new GatewayError(CANCELLED_MESSAGE)
    const { client } = await entry.connection
    if (entry.cwd === null) {
      const home = await exec(client, 'pwd', signal)
      entry.cwd = lastLine(home.stdout) || '/'
    }
    touch(session.id, entry)
    return client
  }

  function run(session, command, { signal } = {}) {
    if (signal && signal.aborted) return Promise.reject(new GatewayError(CANCELLED_MESSAGE))
    const entry = getEntry(session)
    return serialize(entry, async () => {
      const client = await prepare(session, entry, signal)
      const result = await exec(client, `cd ${shellQuote(entry.cwd)} && ${command}`, signal)
      touch(session.id, entry)
      return { cwd: entry.cwd, ...result }
    })
  }

  function changeDirectory(session, target, { signal } = {}) {
    if (signal && signal.aborted) return Promise.reject(new GatewayError(CANCELLED_MESSAGE))
    const entry = getEntry(session)
    return serialize(entry, async () => {
      const client = await prepare(session, entry, signal)
      const result = await exec(client, `cd ${shellQuote(entry.cwd)} && cd -- ${quoteCdTarget(target)} && pwd`, signal)
      if (result.exitCode !== 0) throw new GatewayError(lastLine(result.stderr) || '디렉터리로 이동할 수 없습니다.')
      entry.cwd = lastLine(result.stdout)
      touch(session.id, entry)
      return { cwd: entry.cwd }
    })
  }

  return {
    run,
    changeDirectory,
    getCwd: (sessionId) => (entries.has(sessionId) ? entries.get(sessionId).cwd : null),
    close: (sessionId) => { const entry = entries.get(sessionId); if (entry) drop(sessionId, entry) },
    closeAll: () => [...entries.entries()].forEach(([sessionId, entry]) => drop(sessionId, entry))
  }
}

module.exports = { createSessionGateway, GatewayError }
```

- [ ] **Step 5: 통과 확인**

Run: `npx vitest run src/mcp/sessionGateway.test.js src/sshConnectionTest.test.js`
Expected: PASS (gateway 14 tests + 기존 테스트)

- [ ] **Step 6: 체크박스 갱신**

---

### Task 8: 도구 처리 흐름

**Files:**
- Create: `src/mcp/tools.js`
- Test: `src/mcp/tools.test.js`

**Interfaces:**
- Consumes: `classifyCommand`, `needsApproval` (Task 3), `shellQuote` (Task 2), 승인 중계 `request(details, { signal })` (Task 6), 게이트웨이 `run` / `changeDirectory` / `getCwd` (Task 7), 감사 로그 `append` (Task 4)
- Produces: `createToolHandlers({ isUnlocked, getSessions, getFolders, getAlertLevel, approvals, gateway, audit, newRequestId? })` →
  - `listSessions(): ToolResult`
  - `runCommand({ session, command }, { signal }?): Promise<ToolResult>`
  - `changeDirectory({ session, path }, { signal }?): Promise<ToolResult>`
  - `ToolResult = { content: [{ type: 'text', text: string }], isError?: true }`
  - `folderPath(folders, folderId): string` (테스트·재사용용)
- 확인 창에 넘기는 `details`: `{ sessionName, folder, cwd, command, level, reasons }`

- [ ] **Step 1: 실패하는 테스트 작성** — `src/mcp/tools.test.js`

```js
import { describe, it, expect } from 'vitest'
import toolsModule from './tools.js'

const { createToolHandlers } = toolsModule

const allowed = { id: 's1', name: '[개발] 바우처 WAS', folderId: 'f2', mcpEnabled: true, host: '10.0.0.1', username: 'deploy', password: 'pw' }
const hidden = { id: 's2', name: '[운영] DB', mcpEnabled: false, host: '10.0.0.2' }
const folders = [{ id: 'f1', name: '개발' }, { id: 'f2', name: '[개발] 소상공인 바우처', parentId: 'f1' }]
const okResult = { cwd: '/home/app', exitCode: 0, signal: null, stdout: 'ok\n', stderr: '', truncated: false, timedOut: false, cancelled: false }

function setup({ sessions = [allowed, hidden], alertLevel = 'danger', answer = 'approved', runResult = okResult, runError, auditFails = false, onApproval } = {}) {
  const state = { unlocked: true }
  const auditEntries = []
  const approvalRequests = []
  const runs = []
  const handlers = createToolHandlers({
    isUnlocked: () => state.unlocked,
    getSessions: () => sessions,
    getFolders: () => folders,
    getAlertLevel: () => alertLevel,
    approvals: {
      request: async (details, options) => {
        approvalRequests.push({ details, options })
        if (onApproval) onApproval(state)
        return answer
      }
    },
    gateway: {
      getCwd: () => '/home/app',
      run: async (session, command, options) => {
        runs.push({ session, command, options })
        if (runError) throw runError
        return runResult
      },
      changeDirectory: async (session, path) => ({ cwd: `/home/app/${path}` })
    },
    audit: {
      append: (entry) => {
        if (auditFails) throw new Error('disk full')
        auditEntries.push(entry)
      }
    },
    newRequestId: () => 'r1'
  })
  return { handlers, state, auditEntries, approvalRequests, runs }
}

const textOf = (result) => result.content[0].text

describe('listSessions', () => {
  it('lists only allowed sessions without connection details', () => {
    const { handlers } = setup()
    const result = handlers.listSessions()
    expect(JSON.parse(textOf(result))).toEqual([
      { id: 's1', name: '[개발] 바우처 WAS', folder: '개발 / [개발] 소상공인 바우처', cwd: '/home/app' }
    ])
    expect(textOf(result)).not.toContain('10.0.0.1')
    expect(textOf(result)).not.toContain('deploy')
  })

  it('explains how to allow sessions when none are allowed', () => {
    const { handlers } = setup({ sessions: [hidden] })
    expect(textOf(handlers.listSessions())).toContain('MCP 접근 허용')
  })

  it('refuses while the app is locked', () => {
    const { handlers, state } = setup()
    state.unlocked = false
    const result = handlers.listSessions()
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('잠겨')
  })
})

describe('runCommand', () => {
  it('runs a read command without asking', async () => {
    const { handlers, approvalRequests, runs, auditEntries } = setup()
    const result = await handlers.runCommand({ session: 's1', command: 'ls -al' })
    expect(result.isError).toBeUndefined()
    expect(textOf(result)).toContain('종료 코드: 0')
    expect(textOf(result)).toContain('ok')
    expect(approvalRequests).toHaveLength(0)
    expect(runs[0].command).toBe('ls -al')
    expect(auditEntries.map(entry => entry.phase)).toEqual(['start', 'end'])
    expect(auditEntries[1]).toMatchObject({ outcome: 'executed', exitCode: 0, level: 'low', sessionId: 's1' })
  })

  it('asks before a dangerous command and runs it when approved', async () => {
    const { handlers, approvalRequests, runs, auditEntries } = setup()
    await handlers.runCommand({ session: 's1', command: 'rm app.log' })
    expect(approvalRequests[0].details).toEqual({
      sessionName: '[개발] 바우처 WAS',
      folder: '개발 / [개발] 소상공인 바우처',
      cwd: '/home/app',
      command: 'rm app.log',
      level: 'danger',
      reasons: ['rm: 파일 삭제']
    })
    expect(runs).toHaveLength(1)
    expect(auditEntries[1].outcome).toBe('approved')
  })

  it.each([
    ['denied', '거부'],
    ['expired', '승인되지 않아'],
    ['cancelled', '취소']
  ])('does not run when the answer is %s', async (answer, message) => {
    const { handlers, runs, auditEntries } = setup({ answer })
    const result = await handlers.runCommand({ session: 's1', command: 'rm app.log' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain(message)
    expect(runs).toHaveLength(0)
    expect(auditEntries[1].outcome).toBe(answer)
  })

  it('follows the alert level', async () => {
    const { handlers, approvalRequests } = setup({ alertLevel: 'all' })
    await handlers.runCommand({ session: 's1', command: 'ls' })
    expect(approvalRequests).toHaveLength(1)
  })

  it('blocks forbidden commands without asking', async () => {
    const { handlers, approvalRequests, runs, auditEntries } = setup()
    const result = await handlers.runCommand({ session: 's1', command: 'rm -rf /' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('차단')
    expect(approvalRequests).toHaveLength(0)
    expect(runs).toHaveLength(0)
    expect(auditEntries).toEqual([expect.objectContaining({ phase: 'end', outcome: 'blocked' })])
  })

  it('refuses sessions that are not allowed', async () => {
    const { handlers, runs } = setup()
    const result = await handlers.runCommand({ session: 's2', command: 'ls' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('허용되지 않은 세션')
    expect(runs).toHaveLength(0)
  })

  it('accepts the exact session name', async () => {
    const { handlers, runs } = setup()
    await handlers.runCommand({ session: '[개발] 바우처 WAS', command: 'ls' })
    expect(runs[0].session.id).toBe('s1')
  })

  it('refuses a name shared by several allowed sessions', async () => {
    const twin = { ...allowed, id: 's3' }
    const { handlers, runs } = setup({ sessions: [allowed, twin] })
    const result = await handlers.runCommand({ session: '[개발] 바우처 WAS', command: 'ls' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('이름이 같은 세션')
    expect(runs).toHaveLength(0)
  })

  it('does not run when the audit log cannot be written', async () => {
    const { handlers, runs } = setup({ auditFails: true })
    const result = await handlers.runCommand({ session: 's1', command: 'ls' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('감사 로그')
    expect(runs).toHaveLength(0)
  })

  it('does not run when the app locks during the approval', async () => {
    const { handlers, runs, auditEntries } = setup({ onApproval: (state) => { state.unlocked = false } })
    const result = await handlers.runCommand({ session: 's1', command: 'rm app.log' })
    expect(result.isError).toBe(true)
    expect(runs).toHaveLength(0)
    expect(auditEntries[1].outcome).toBe('cancelled')
  })

  it('does not run a request that was cancelled', async () => {
    const { handlers, runs } = setup()
    const controller = new AbortController()
    controller.abort()
    const result = await handlers.runCommand({ session: 's1', command: 'ls' }, { signal: controller.signal })
    expect(result.isError).toBe(true)
    expect(runs).toHaveLength(0)
  })

  it('passes the cancel signal to the approval and the gateway', async () => {
    const { handlers, approvalRequests, runs } = setup()
    const controller = new AbortController()
    await handlers.runCommand({ session: 's1', command: 'rm app.log' }, { signal: controller.signal })
    expect(approvalRequests[0].options.signal).toBe(controller.signal)
    expect(runs[0].options.signal).toBe(controller.signal)
  })

  it('reports gateway failures', async () => {
    const { handlers, auditEntries } = setup({ runError: Object.assign(new Error('auth'), { userMessage: '인증에 실패했습니다.' }) })
    const result = await handlers.runCommand({ session: 's1', command: 'ls' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('인증에 실패했습니다.')
    expect(auditEntries[1]).toMatchObject({ outcome: 'failed', error: '인증에 실패했습니다.' })
  })

  it('notes truncated and timed out output', async () => {
    const { handlers } = setup({ runResult: { ...okResult, exitCode: null, truncated: true, timedOut: true, stderr: 'warn' } })
    const text = textOf(await handlers.runCommand({ session: 's1', command: 'ls' }))
    expect(text).toContain('시간 제한')
    expect(text).toContain('일부만')
    expect(text).toContain('--- stderr ---')
  })
})

describe('changeDirectory', () => {
  it('moves and reports the new directory', async () => {
    const { handlers, auditEntries } = setup()
    const result = await handlers.changeDirectory({ session: 's1', path: 'logs' })
    expect(textOf(result)).toContain('작업 디렉터리: /home/app/logs')
    expect(auditEntries[0].command).toBe("cd 'logs'")
  })

  it('asks before entering a secrets directory when the level is medium', async () => {
    const { handlers, approvalRequests } = setup({ alertLevel: 'medium' })
    await handlers.changeDirectory({ session: 's1', path: '~/.ssh' })
    expect(approvalRequests).toHaveLength(1)
  })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/mcp/tools.test.js`
Expected: FAIL (모듈 없음)

- [ ] **Step 3: 구현** — `src/mcp/tools.js`

```js
// What each MCP tool does: find the session, judge the command, ask the user when
// needed, run it, and log the request before and after.
const crypto = require('crypto')
const { classifyCommand, needsApproval } = require('./commandPolicy.js')
const { shellQuote } = require('./shellQuote.js')

const LOCKED_MESSAGE = '앱이 잠겨 있습니다. 앱에서 잠금을 해제하세요.'
const NOT_ALLOWED_MESSAGE = '허용되지 않은 세션입니다. list_sessions 로 사용할 수 있는 세션을 확인하세요.'
const NO_SESSIONS_MESSAGE = 'MCP 접근이 허용된 세션이 없습니다. 앱의 세션 편집 > 고급 설정에서 "MCP 접근 허용"을 켜세요.'
const SESSIONS_UNREADABLE_MESSAGE = '세션 정보를 읽지 못했습니다.'
const DENIAL_MESSAGES = {
  denied: '사용자가 실행을 거부했습니다.',
  expired: '제한 시간 안에 승인되지 않아 실행하지 않았습니다.',
  cancelled: '요청이 취소되어 실행하지 않았습니다.'
}

const textResult = (text, isError = false) => (isError
  ? { content: [{ type: 'text', text }], isError: true }
  : { content: [{ type: 'text', text }] })

function folderPath(folders, folderId) {
  const byId = new Map(folders.map(folder => [folder.id, folder]))
  const names = []
  const visited = new Set()
  let current = folderId ? byId.get(folderId) : undefined
  while (current && !visited.has(current.id)) {
    visited.add(current.id)
    names.unshift(current.name)
    current = current.parentId ? byId.get(current.parentId) : undefined
  }
  return names.join(' / ')
}

function formatRunResult(session, result) {
  const lines = [
    `세션: ${session.name}`,
    `위치: ${result.cwd}`,
    `종료 코드: ${result.exitCode ?? '없음'}${result.signal ? ` (시그널 ${result.signal})` : ''}`
  ]
  if (result.timedOut) lines.push('[주의] 실행 시간 제한을 넘어 중단했습니다. 출력은 중단 시점까지입니다.')
  if (result.truncated) lines.push('[주의] 출력이 너무 길어 일부만 표시합니다.')
  lines.push('--- stdout ---', result.stdout || '(없음)')
  if (result.stderr) lines.push('--- stderr ---', result.stderr)
  return lines.join('\n')
}

function createToolHandlers({ isUnlocked, getSessions, getFolders, getAlertLevel, approvals, gateway, audit, newRequestId = () => crypto.randomUUID() }) {
  function allowedSessions() {
    return getSessions().filter(session => session.mcpEnabled === true && !session.decryptionFailed && !session.needsMigration)
  }

  function findSession(sessions, ref) {
    const byId = sessions.find(session => session.id === ref)
    if (byId) return { session: byId }
    const byName = sessions.filter(session => session.name === ref)
    if (byName.length === 1) return { session: byName[0] }
    if (byName.length > 1) return { error: `이름이 같은 세션이 ${byName.length}개 있습니다. list_sessions 의 id 를 사용하세요.` }
    return { error: NOT_ALLOWED_MESSAGE }
  }

  function writeLog(entry) {
    try {
      audit.append(entry)
      return true
    } catch {
      return false
    }
  }

  async function guarded({ ref, command, signal, perform, format }) {
    if (!isUnlocked()) return textResult(LOCKED_MESSAGE, true)
    let sessions
    try {
      sessions = allowedSessions()
    } catch {
      return textResult(SESSIONS_UNREADABLE_MESSAGE, true)
    }
    const found = findSession(sessions, ref)
    if (found.error) return textResult(found.error, true)
    const { session } = found

    const verdict = classifyCommand(command)
    const base = { requestId: newRequestId(), sessionId: session.id, sessionName: session.name, command, level: verdict.level, reasons: verdict.reasons }
    if (verdict.level === 'forbidden') {
      writeLog({ ...base, phase: 'end', outcome: 'blocked' })
      return textResult(`차단된 명령입니다 (${verdict.reasons.join(', ')}). 이 명령은 MCP 로 실행할 수 없습니다.`, true)
    }
    if (!writeLog({ ...base, phase: 'start' })) return textResult('감사 로그를 기록할 수 없어 실행하지 않았습니다.', true)
    const finish = (fields) => writeLog({ ...base, phase: 'end', ...fields })

    let approved = false
    if (needsApproval(verdict.level, getAlertLevel())) {
      const outcome = await approvals.request({
        sessionName: session.name,
        folder: folderPath(getFolders(), session.folderId),
        cwd: gateway.getCwd(session.id),
        command,
        level: verdict.level,
        reasons: verdict.reasons
      }, { signal })
      if (outcome !== 'approved') {
        finish({ outcome })
        return textResult(DENIAL_MESSAGES[outcome] || DENIAL_MESSAGES.denied, true)
      }
      approved = true
    }

    if (!isUnlocked() || (signal && signal.aborted)) {
      finish({ outcome: 'cancelled' })
      return textResult(isUnlocked() ? DENIAL_MESSAGES.cancelled : LOCKED_MESSAGE, true)
    }

    try {
      const result = await perform(session, signal)
      finish({ outcome: approved ? 'approved' : 'executed', exitCode: result.exitCode ?? null, timedOut: result.timedOut === true, truncated: result.truncated === true })
      return textResult(format(session, result))
    } catch (err) {
      const message = err.userMessage || '알 수 없는 오류가 발생했습니다.'
      finish({ outcome: 'failed', error: message })
      return textResult(`실행하지 못했습니다: ${message}`, true)
    }
  }

  function listSessions() {
    if (!isUnlocked()) return textResult(LOCKED_MESSAGE, true)
    let sessions
    try {
      sessions = allowedSessions()
    } catch {
      return textResult(SESSIONS_UNREADABLE_MESSAGE, true)
    }
    if (sessions.length === 0) return textResult(NO_SESSIONS_MESSAGE)
    const folders = getFolders()
    const list = sessions.map(session => ({
      id: session.id,
      name: session.name,
      folder: folderPath(folders, session.folderId),
      cwd: gateway.getCwd(session.id)
    }))
    return textResult(JSON.stringify(list, null, 2))
  }

  function runCommand({ session, command }, { signal } = {}) {
    return guarded({
      ref: session,
      command,
      signal,
      perform: (target, cancel) => gateway.run(target, command, { signal: cancel }),
      format: formatRunResult
    })
  }

  function changeDirectory({ session, path }, { signal } = {}) {
    return guarded({
      ref: session,
      command: `cd ${shellQuote(path)}`,
      signal,
      perform: (target, cancel) => gateway.changeDirectory(target, path, { signal: cancel }),
      format: (target, result) => `세션: ${target.name}\n작업 디렉터리: ${result.cwd}`
    })
  }

  return { listSessions, runCommand, changeDirectory }
}

module.exports = { createToolHandlers, folderPath }
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run src/mcp/tools.test.js`
Expected: PASS (21 tests)

- [ ] **Step 5: 체크박스 갱신**

---

### Task 9: MCP HTTP 서버

**Files:**
- Create: `src/mcp/server.js`
- Test: `src/mcp/server.test.js`

**Interfaces:**
- Consumes: `{ McpServer, StreamableHTTPServerTransport, z }` (Task 1), 핸들러 3개 (Task 8 의 반환값과 같은 모양)
- Produces: `createMcpHttpServer({ getConfig: () => ({ port, token }), handlers, version })` →
  - `start(): Promise<void>` — 실패 시 Node 의 listen 오류(`code: 'EADDRINUSE'` 등)로 reject
  - `stop(): Promise<void>`
  - `isRunning(): boolean`
  - `port(): number | null` — 실제로 듣고 있는 포트 (`port: 0` 으로 시작하면 OS 가 고른 포트)
  - 상수 `MCP_PATH = '/mcp'`
- 핸들러 호출 형태: `handlers.runCommand(args, { signal })`, `handlers.changeDirectory(args, { signal })`, `handlers.listSessions()`

- [ ] **Step 1: 실패하는 테스트 작성** — `src/mcp/server.test.js`

```js
import { describe, it, expect, afterEach, vi } from 'vitest'
import http from 'http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import serverModule from './server.js'

const { createMcpHttpServer } = serverModule
const TOKEN = 'ab'.repeat(32)

let server

afterEach(async () => {
  await server?.stop()
  server = undefined
})

const text = (value) => ({ content: [{ type: 'text', text: value }] })
const stubHandlers = (overrides = {}) => ({
  listSessions: () => text('[]'),
  changeDirectory: async () => text('cd ok'),
  runCommand: async (args) => text(`ran ${args.command}`),
  ...overrides
})

async function startServer(handlers = stubHandlers()) {
  server = createMcpHttpServer({ getConfig: () => ({ port: 0, token: TOKEN }), handlers, version: 'test' })
  await server.start()
  return `http://127.0.0.1:${server.port()}/mcp`
}

async function connect(url) {
  const client = new Client({ name: 'test', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }))
  return client
}

const postInit = (url, headers) => fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })
})

describe('createMcpHttpServer', () => {
  it('lists the three tools', async () => {
    const client = await connect(await startServer())
    const { tools } = await client.listTools()
    expect(tools.map(tool => tool.name).sort()).toEqual(['cd', 'list_sessions', 'run_command'])
    await client.close()
  })

  it('passes tool arguments to the handlers', async () => {
    const client = await connect(await startServer())
    const result = await client.callTool({ name: 'run_command', arguments: { session: 's1', command: 'ls -al' } })
    expect(result.content[0].text).toBe('ran ls -al')
    await client.close()
  })

  it('rejects a wrong token', async () => {
    const url = await startServer()
    expect((await postInit(url, { Authorization: 'Bearer nope' })).status).toBe(401)
    expect((await postInit(url, {})).status).toBe(401)
  })

  it('rejects browser requests', async () => {
    const url = await startServer()
    expect((await postInit(url, { Authorization: `Bearer ${TOKEN}`, Origin: 'https://evil.example' })).status).toBe(403)
  })

  it('rejects other Host headers', async () => {
    await startServer()
    const status = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: server.port(), path: '/mcp', method: 'POST', headers: { Host: 'evil.example', Authorization: `Bearer ${TOKEN}` } }, (res) => { res.resume(); resolve(res.statusCode) })
      req.on('error', reject)
      req.end('{}')
    })
    expect(status).toBe(403)
  })

  it('answers 404 outside /mcp', async () => {
    const url = await startServer()
    expect((await fetch(url.replace('/mcp', '/other'), { method: 'POST' })).status).toBe(404)
  })

  it('reports a busy port', async () => {
    await startServer()
    const second = createMcpHttpServer({ getConfig: () => ({ port: server.port(), token: TOKEN }), handlers: stubHandlers(), version: 'test' })
    await expect(second.start()).rejects.toMatchObject({ code: 'EADDRINUSE' })
    expect(second.isRunning()).toBe(false)
  })

  it('tells the handler when the client goes away', async () => {
    let seenSignal
    const url = await startServer(stubHandlers({
      runCommand: (args, { signal }) => new Promise((resolve) => {
        seenSignal = signal
        signal.addEventListener('abort', () => resolve(text('aborted')))
      })
    }))
    const client = await connect(url)
    const call = client.callTool({ name: 'run_command', arguments: { session: 's1', command: 'sleep' } }).catch(() => 'closed')
    await vi.waitFor(() => expect(seenSignal).toBeDefined())
    await client.close()
    await call
    await vi.waitFor(() => expect(seenSignal.aborted).toBe(true))
  })

  it('stops listening', async () => {
    const url = await startServer()
    await server.stop()
    expect(server.isRunning()).toBe(false)
    await expect(postInit(url, { Authorization: `Bearer ${TOKEN}` })).rejects.toThrow()
  })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/mcp/server.test.js`
Expected: FAIL (모듈 없음)

- [ ] **Step 3: 구현** — `src/mcp/server.js`

```js
// Local MCP endpoint for Claude Code (Streamable HTTP, stateless: one MCP server per request).
// Listens on 127.0.0.1 only, needs the bearer token, and refuses anything from a browser page.
const http = require('http')
const crypto = require('crypto')
const { McpServer, StreamableHTTPServerTransport, z } = require('./sdk.js')

const MCP_PATH = '/mcp'
const BIND_HOST = '127.0.0.1'
const MAX_BODY_BYTES = 1024 * 1024
const MAX_COMMAND_LENGTH = 4000
const MAX_PATH_LENGTH = 1024

const DESCRIPTIONS = {
  listSessions: '이 SSH 클라이언트 앱에서 MCP 접근이 허용된 세션 목록(id, 이름, 폴더, 현재 작업 디렉터리)을 돌려줍니다. 다른 도구의 session 인자에는 여기서 받은 id 를 넘기세요.',
  cd: '세션의 작업 디렉터리를 바꿉니다. 이후 run_command 는 이 디렉터리에서 실행됩니다. run_command 안에서 실행한 cd 는 그 명령에만 적용됩니다.',
  runCommand: '세션 서버에서 셸 명령을 실행하고 종료 코드와 출력을 돌려줍니다. 30초 제한, 출력 64KB 제한이 있습니다. 서버 상태를 바꾸는 명령은 사용자가 앱에서 승인해야 실행되고, 시스템 종료·루트 삭제 같은 명령은 항상 차단됩니다. 가능하면 조회 명령을 쓰세요.'
}

function bearerMatches(expected, header) {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false
  const given = Buffer.from(header.slice('Bearer '.length))
  const wanted = Buffer.from(expected)
  return given.length === wanted.length && crypto.timingSafeEqual(given, wanted)
}

function sendError(res, status, message) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }))
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request too large'), { status: 413 }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(Object.assign(new Error('Invalid JSON'), { status: 400 }))
      }
    })
    req.on('error', reject)
  })
}

/** AbortSignal.any() does not exist on Node 18 */
function combineSignals(signals) {
  const controller = new AbortController()
  for (const signal of signals.filter(Boolean)) {
    if (signal.aborted) { controller.abort(); break }
    signal.addEventListener('abort', () => controller.abort(), { once: true })
  }
  return controller.signal
}

function buildMcpServer(handlers, { version, signal }) {
  const server = new McpServer({ name: 'my-ssh-client', version })
  const sessionArg = z.string().min(1).describe('list_sessions 에서 받은 세션 id')
  server.registerTool('list_sessions', { description: DESCRIPTIONS.listSessions }, async () => handlers.listSessions())
  server.registerTool('cd', {
    description: DESCRIPTIONS.cd,
    inputSchema: { session: sessionArg, path: z.string().min(1).max(MAX_PATH_LENGTH).describe('이동할 경로 (절대 경로 또는 현재 위치 기준 상대 경로)') }
  }, async (args, extra) => handlers.changeDirectory(args, { signal: combineSignals([signal, extra && extra.signal]) }))
  server.registerTool('run_command', {
    description: DESCRIPTIONS.runCommand,
    inputSchema: { session: sessionArg, command: z.string().min(1).max(MAX_COMMAND_LENGTH).describe('실행할 셸 명령') }
  }, async (args, extra) => handlers.runCommand(args, { signal: combineSignals([signal, extra && extra.signal]) }))
  return server
}

function createMcpHttpServer({ getConfig, handlers, version }) {
  let httpServer = null
  let listeningPort = null

  async function handle(req, res) {
    const { pathname } = new URL(req.url, 'http://localhost')
    if (pathname !== MCP_PATH) return sendError(res, 404, 'Not found')
    const host = req.headers.host
    if (host !== `127.0.0.1:${listeningPort}` && host !== `localhost:${listeningPort}`) return sendError(res, 403, 'Forbidden host')
    if (req.headers.origin !== undefined) return sendError(res, 403, 'Browser requests are not allowed')
    if (!bearerMatches(getConfig().token, req.headers.authorization)) return sendError(res, 401, 'Unauthorized')
    if (req.method !== 'POST') return sendError(res, 405, 'Method not allowed')

    let body
    try {
      body = await readJsonBody(req)
    } catch (err) {
      return sendError(res, err.status || 400, err.message)
    }

    const abort = new AbortController()
    const server = buildMcpServer(handlers, { version, signal: abort.signal })
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on('close', () => {
      if (!res.writableFinished) abort.abort()
      transport.close()
      server.close()
    })
    await server.connect(transport)
    await transport.handleRequest(req, res, body)
  }

  function start() {
    if (httpServer) return Promise.resolve()
    const { port } = getConfig()
    return new Promise((resolve, reject) => {
      const created = http.createServer((req, res) => {
        handle(req, res).catch(() => {
          if (!res.headersSent) sendError(res, 500, 'Internal error')
        })
      })
      created.once('error', reject)
      created.listen(port, BIND_HOST, () => {
        created.removeListener('error', reject)
        created.on('error', () => { /* per-connection errors are not fatal */ })
        httpServer = created
        listeningPort = created.address().port
        resolve()
      })
    })
  }

  function stop() {
    if (!httpServer) return Promise.resolve()
    const closing = httpServer
    httpServer = null
    listeningPort = null
    return new Promise((resolve) => {
      closing.close(() => resolve())
      closing.closeAllConnections()
    })
  }

  return { start, stop, isRunning: () => httpServer !== null, port: () => listeningPort }
}

module.exports = { createMcpHttpServer, MCP_PATH }
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run src/mcp/server.test.js`
Expected: PASS (9 tests)

- [ ] **Step 5: Electron 의 Node 에서 한 번 더 확인**

Vitest 는 Node 24 로 돈다. Electron 28(Node 18) 에서도 서버가 뜨고 401 을 주는지 확인한다.

Run:
```bash
ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe -e "const {createMcpHttpServer}=require('./src/mcp/server.js');const s=createMcpHttpServer({getConfig:()=>({port:0,token:'ab'.repeat(32)}),handlers:{},version:'t'});s.start().then(async()=>{const r=await fetch('http://127.0.0.1:'+s.port()+'/mcp',{method:'POST'});console.log('status',r.status);await s.stop()})"
```
Expected: `status 401`

- [ ] **Step 6: 체크박스 갱신**

---

### Task 10: 컨트롤러와 IPC

**Files:**
- Create: `src/mcp/controller.js`, `src/mcp/ipc.js`
- Test: `src/mcp/controller.test.js`, `src/mcp/ipc.test.js`

**Interfaces:**
- Consumes: Task 4~9 의 생성 함수
- Produces:
  - `createMcpController({ userDataPath, version, isUnlocked, loadSessions, loadFolders, showApproval, dismissApproval, deps? })` →
    `{ start(): Promise<Status>, getStatus(): Status, updateConfig(patch): Promise<Status>, regenerateToken(): Promise<Status>, respondApproval(id, approved): boolean, readAudit(limit): object[], onLocked(): void, onSessionsSaved(): void, shutdown(): Promise<void> }`
    - `Status = { config: McpConfig, running: boolean, error: string | null, registerCommand: string }`
    - `deps` (테스트용): `{ createServer?, approvals?, gateway?, audit?, configStore? }`
  - `registerMcpIpc(ipcMain, getController)` — 채널:
    - `mcp-get-status` → `{ success: true, status } | { success: false, error }`
    - `mcp-update-config` (patch) → 같은 모양
    - `mcp-regenerate-token` → 같은 모양
    - `mcp-respond-approval` (`{ id, approved }`) → `{ success: boolean }`
    - `mcp-read-audit` (`{ limit }`) → `{ success: true, entries } | { success: false, error, entries: [] }`

- [ ] **Step 1: 실패하는 테스트 작성** — `src/mcp/controller.test.js`

```js
import { describe, it, expect, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import controllerModule from './controller.js'

const { createMcpController } = controllerModule

function fakeServerFactory({ failWith } = {}) {
  const calls = { start: 0, stop: 0 }
  const factory = ({ getConfig }) => {
    let port = null
    return {
      async start() {
        calls.start++
        if (failWith) throw failWith
        port = getConfig().port
      },
      async stop() { calls.stop++; port = null },
      isRunning: () => port !== null,
      port: () => port
    }
  }
  return { factory, calls }
}

function setup(options = {}) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-controller-'))
  const server = fakeServerFactory(options)
  const approvals = { cancelAll: vi.fn(), respond: vi.fn(() => true), request: vi.fn() }
  const gateway = { closeAll: vi.fn(), getCwd: () => null }
  const controller = createMcpController({
    userDataPath,
    version: 'test',
    isUnlocked: () => true,
    loadSessions: () => [],
    loadFolders: () => [],
    showApproval: () => true,
    dismissApproval: () => {},
    deps: { createServer: server.factory, approvals, gateway }
  })
  return { controller, server, approvals, gateway, userDataPath }
}

describe('createMcpController', () => {
  it('stays off by default', async () => {
    const { controller, server } = setup()
    expect((await controller.start()).running).toBe(false)
    expect(server.calls.start).toBe(0)
  })

  it('starts when enabled and shows the register command', async () => {
    const { controller } = setup()
    const status = await controller.updateConfig({ enabled: true })
    expect(status.running).toBe(true)
    expect(status.error).toBeNull()
    expect(status.registerCommand).toBe(
      `claude mcp add --transport http my-ssh-client http://127.0.0.1:47521/mcp --header "Authorization: Bearer ${status.config.token}"`
    )
  })

  it('explains a port that is already in use', async () => {
    const { controller } = setup({ failWith: Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' }) })
    const status = await controller.updateConfig({ enabled: true })
    expect(status.running).toBe(false)
    expect(status.error).toBe('포트 47521 이(가) 이미 사용 중입니다. 다른 포트를 지정하세요.')
  })

  it('stops and drops connections when disabled', async () => {
    const { controller, server, approvals, gateway } = setup()
    await controller.updateConfig({ enabled: true })
    const status = await controller.updateConfig({ enabled: false })
    expect(status.running).toBe(false)
    expect(server.calls.stop).toBe(1)
    expect(approvals.cancelAll).toHaveBeenCalled()
    expect(gateway.closeAll).toHaveBeenCalled()
  })

  it('restarts on a new port', async () => {
    const { controller, server } = setup()
    await controller.updateConfig({ enabled: true })
    const status = await controller.updateConfig({ port: 50000 })
    expect(server.calls).toEqual({ start: 2, stop: 1 })
    expect(status.registerCommand).toContain('http://127.0.0.1:50000/mcp')
  })

  it('rejects invalid settings', async () => {
    const { controller } = setup()
    await expect(controller.updateConfig({ port: 1 })).rejects.toThrow('포트')
  })

  it('keeps the server running when the token changes', async () => {
    const { controller, server } = setup()
    const before = (await controller.updateConfig({ enabled: true })).config.token
    const status = await controller.regenerateToken()
    expect(status.config.token).not.toBe(before)
    expect(status.running).toBe(true)
    expect(server.calls.start).toBe(1)
  })

  it('cancels approvals and closes connections when the app locks', () => {
    const { controller, approvals, gateway } = setup()
    controller.onLocked()
    expect(approvals.cancelAll).toHaveBeenCalled()
    expect(gateway.closeAll).toHaveBeenCalled()
  })

  it('closes connections when sessions are saved', () => {
    const { controller, gateway } = setup()
    controller.onSessionsSaved()
    expect(gateway.closeAll).toHaveBeenCalled()
  })

  it('stores settings in mcp.json', async () => {
    const { controller, userDataPath } = setup()
    await controller.updateConfig({ enabled: true })
    expect(JSON.parse(fs.readFileSync(path.join(userDataPath, 'mcp.json'), 'utf8')).enabled).toBe(true)
  })

  it('forwards approval answers', () => {
    const { controller, approvals } = setup()
    expect(controller.respondApproval('a1', true)).toBe(true)
    expect(approvals.respond).toHaveBeenCalledWith('a1', true)
  })

  it('stops the server on shutdown', async () => {
    const { controller, server } = setup()
    await controller.updateConfig({ enabled: true })
    await controller.shutdown()
    expect(server.calls.stop).toBe(1)
    expect(controller.getStatus().running).toBe(false)
  })
})
```

- [ ] **Step 2: 실패하는 테스트 작성** — `src/mcp/ipc.test.js`

```js
import { describe, it, expect } from 'vitest'
import ipcModule from './ipc.js'

const { registerMcpIpc } = ipcModule

function fakeIpcMain() {
  const handlers = {}
  return { handlers, handle: (channel, fn) => { handlers[channel] = fn } }
}

const status = { config: { enabled: false, port: 47521, alertLevel: 'danger', token: 't' }, running: false, error: null, registerCommand: 'x' }

describe('registerMcpIpc', () => {
  it('returns the status', async () => {
    const ipcMain = fakeIpcMain()
    registerMcpIpc(ipcMain, () => ({ getStatus: () => status }))
    expect(await ipcMain.handlers['mcp-get-status']({})).toEqual({ success: true, status })
  })

  it('turns a rejected change into an error result', async () => {
    const ipcMain = fakeIpcMain()
    registerMcpIpc(ipcMain, () => ({ updateConfig: async () => { throw new Error('포트는 1024~65535 사이의 정수여야 합니다.') } }))
    expect(await ipcMain.handlers['mcp-update-config']({}, { port: 1 }))
      .toEqual({ success: false, error: '포트는 1024~65535 사이의 정수여야 합니다.' })
  })

  it('reports when the controller is not ready', async () => {
    const ipcMain = fakeIpcMain()
    registerMcpIpc(ipcMain, () => null)
    expect((await ipcMain.handlers['mcp-get-status']({})).success).toBe(false)
    expect(await ipcMain.handlers['mcp-respond-approval']({}, { id: 'a1', approved: true })).toEqual({ success: false })
  })

  it('only approves with a string id and approved === true', async () => {
    const ipcMain = fakeIpcMain()
    const answers = []
    registerMcpIpc(ipcMain, () => ({ respondApproval: (id, approved) => { answers.push([id, approved]); return true } }))
    await ipcMain.handlers['mcp-respond-approval']({}, { id: 'a1', approved: 'yes' })
    expect(await ipcMain.handlers['mcp-respond-approval']({}, { id: 5, approved: true })).toEqual({ success: false })
    expect(answers).toEqual([['a1', false]])
  })

  it('clamps the audit limit', async () => {
    const ipcMain = fakeIpcMain()
    const limits = []
    registerMcpIpc(ipcMain, () => ({ readAudit: (limit) => { limits.push(limit); return [] } }))
    await ipcMain.handlers['mcp-read-audit']({}, { limit: 100000 })
    await ipcMain.handlers['mcp-read-audit']({}, { limit: 'x' })
    expect(limits).toEqual([500, 200])
  })
})
```

- [ ] **Step 3: 실패 확인**

Run: `npx vitest run src/mcp/controller.test.js src/mcp/ipc.test.js`
Expected: FAIL (모듈 없음)

- [ ] **Step 4: 구현** — `src/mcp/controller.js`

```js
// Wires the MCP pieces together for main.js: settings, server lifecycle, approvals, locking.
const path = require('path')
const { createMcpConfigStore } = require('./mcpConfig.js')
const { createAuditLog } = require('./auditLog.js')
const { createApprovalBroker } = require('./approval.js')
const { createSessionGateway } = require('./sessionGateway.js')
const { createToolHandlers } = require('./tools.js')
const { createMcpHttpServer, MCP_PATH } = require('./server.js')

const SERVER_NAME = 'my-ssh-client'

function buildRegisterCommand({ port, token }) {
  return `claude mcp add --transport http ${SERVER_NAME} http://127.0.0.1:${port}${MCP_PATH} --header "Authorization: Bearer ${token}"`
}

function describeStartError(err, port) {
  if (err && err.code === 'EADDRINUSE') return `포트 ${port} 이(가) 이미 사용 중입니다. 다른 포트를 지정하세요.`
  if (err && err.code === 'EACCES') return `포트 ${port} 을(를) 사용할 권한이 없습니다. 다른 포트를 지정하세요.`
  return `MCP 서버를 시작하지 못했습니다: ${err && err.message}`
}

function createMcpController({ userDataPath, version, isUnlocked, loadSessions, loadFolders, showApproval, dismissApproval, deps = {} }) {
  const configStore = deps.configStore || createMcpConfigStore({ filePath: path.join(userDataPath, 'mcp.json') })
  const audit = deps.audit || createAuditLog({ filePath: path.join(userDataPath, 'mcp-audit.log') })
  const approvals = deps.approvals || createApprovalBroker({ show: showApproval, dismiss: dismissApproval })
  const gateway = deps.gateway || createSessionGateway()
  const handlers = createToolHandlers({
    isUnlocked,
    getSessions: loadSessions,
    getFolders: loadFolders,
    getAlertLevel: () => configStore.get().alertLevel,
    approvals,
    gateway,
    audit
  })
  const createServer = deps.createServer || createMcpHttpServer
  const server = createServer({ getConfig: () => configStore.get(), handlers, version })
  let lastError = null

  function getStatus() {
    const config = configStore.get()
    return { config, running: server.isRunning(), error: lastError, registerCommand: buildRegisterCommand(config) }
  }

  function disconnectAll() {
    approvals.cancelAll()
    gateway.closeAll()
  }

  async function sync() {
    const config = configStore.get()
    lastError = null
    if (server.isRunning() && (!config.enabled || server.port() !== config.port)) {
      await server.stop()
      disconnectAll()
    }
    if (config.enabled && !server.isRunning()) {
      try {
        await server.start()
      } catch (err) {
        lastError = describeStartError(err, config.port)
      }
    }
    return getStatus()
  }

  return {
    start: sync,
    getStatus,
    async updateConfig(patch) {
      configStore.update(patch)
      return sync()
    },
    async regenerateToken() {
      configStore.regenerateToken()
      return getStatus()
    },
    respondApproval: (id, approved) => approvals.respond(id, approved),
    readAudit: (limit) => audit.readRecent(limit),
    onLocked: disconnectAll,
    onSessionsSaved: () => gateway.closeAll(),
    async shutdown() {
      disconnectAll()
      await server.stop()
    }
  }
}

module.exports = { createMcpController, buildRegisterCommand }
```

- [ ] **Step 5: 구현** — `src/mcp/ipc.js`

```js
// IPC between the renderer's MCP screens and the controller in the main process.
const DEFAULT_AUDIT_LIMIT = 200
const MAX_AUDIT_LIMIT = 500
const NOT_READY_MESSAGE = 'MCP 기능이 아직 준비되지 않았습니다.'

function registerMcpIpc(ipcMain, getController) {
  const withStatus = (task) => async (event, payload) => {
    const controller = getController()
    if (!controller) return { success: false, error: NOT_READY_MESSAGE }
    try {
      return { success: true, status: await task(controller, payload) }
    } catch (err) {
      return { success: false, error: err.message }
    }
  }

  ipcMain.handle('mcp-get-status', withStatus((controller) => controller.getStatus()))
  ipcMain.handle('mcp-update-config', withStatus((controller, patch) => controller.updateConfig(patch)))
  ipcMain.handle('mcp-regenerate-token', withStatus((controller) => controller.regenerateToken()))

  ipcMain.handle('mcp-respond-approval', (event, payload) => {
    const controller = getController()
    const id = payload && typeof payload.id === 'string' ? payload.id : ''
    if (!controller || !id) return { success: false }
    return { success: controller.respondApproval(id, payload.approved === true) === true }
  })

  ipcMain.handle('mcp-read-audit', (event, payload) => {
    const controller = getController()
    const requested = Number(payload && payload.limit)
    const limit = Number.isInteger(requested) && requested > 0 ? Math.min(requested, MAX_AUDIT_LIMIT) : DEFAULT_AUDIT_LIMIT
    if (!controller) return { success: false, error: NOT_READY_MESSAGE, entries: [] }
    try {
      return { success: true, entries: controller.readAudit(limit) }
    } catch (err) {
      return { success: false, error: err.message, entries: [] }
    }
  })
}

module.exports = { registerMcpIpc }
```

- [ ] **Step 6: 통과 확인**

Run: `npx vitest run src/mcp`
Expected: `src/mcp` 의 모든 테스트 PASS

- [ ] **Step 7: 체크박스 갱신**

---

### Task 11: main 프로세스와 preload 연결

**Files:**
- Modify: `main.js`, `src/preload.js`, `src/renderer/types/index.ts`

**Interfaces:**
- Consumes: `createMcpController`, `registerMcpIpc` (Task 10)
- Produces (렌더러가 씀, `window.electronAPI`):
  - `mcpGetStatus(): Promise<McpStatusResult>`
  - `mcpUpdateConfig(patch: Partial<Pick<McpConfig, 'enabled' | 'port' | 'alertLevel'>>): Promise<McpStatusResult>`
  - `mcpRegenerateToken(): Promise<McpStatusResult>`
  - `mcpRespondApproval(id: string, approved: boolean): Promise<{ success: boolean }>`
  - `mcpReadAudit(limit: number): Promise<{ success: boolean, entries: McpAuditEntry[], error?: string }>`
  - `onMcpApprovalRequest(cb: (request: McpApprovalRequest) => void): () => void`
  - `onMcpApprovalDismiss(cb: (payload: { id: string }) => void): () => void`

> 이 태스크부터 main/preload 가 바뀐다. 사용자가 dev 모드 앱을 쓰는 중이면 "앱을 재시작해야 반영된다"고 먼저 알린다.

- [ ] **Step 1: 렌더러 타입 추가** — `src/renderer/types/index.ts`

`declare global` 블록 **앞**에 추가:

```ts
export type McpAlertLevel = 'all' | 'medium' | 'danger'
export type McpRiskLevel = 'low' | 'medium' | 'danger' | 'forbidden'
export type McpAuditOutcome = 'executed' | 'approved' | 'denied' | 'expired' | 'cancelled' | 'blocked' | 'failed'

export interface McpConfig {
  enabled: boolean
  port: number
  alertLevel: McpAlertLevel
  token: string
}

export interface McpStatus {
  config: McpConfig
  running: boolean
  error: string | null
  registerCommand: string
}

export type McpStatusResult = { success: true; status: McpStatus } | { success: false; error: string }

export interface McpApprovalRequest {
  id: string
  sessionName: string
  folder: string
  cwd: string | null
  command: string
  level: McpRiskLevel
  reasons: string[]
  expiresAt: number
}

export interface McpAuditEntry {
  time: string
  requestId: string
  sessionId: string
  sessionName: string
  command: string
  level: McpRiskLevel
  reasons: string[]
  outcome: McpAuditOutcome
  exitCode?: number | null
  timedOut?: boolean
  truncated?: boolean
  error?: string
}
```

`interface Window { electronAPI: { ... } }` 안, `appZoomReset?: () => void` 근처에 추가:

```ts
      mcpGetStatus?: () => Promise<McpStatusResult>
      mcpUpdateConfig?: (patch: Partial<Pick<McpConfig, 'enabled' | 'port' | 'alertLevel'>>) => Promise<McpStatusResult>
      mcpRegenerateToken?: () => Promise<McpStatusResult>
      mcpRespondApproval?: (id: string, approved: boolean) => Promise<{ success: boolean }>
      mcpReadAudit?: (limit: number) => Promise<{ success: boolean; entries: McpAuditEntry[]; error?: string }>
      onMcpApprovalRequest?: (callback: (request: McpApprovalRequest) => void) => () => void
      onMcpApprovalDismiss?: (callback: (payload: { id: string }) => void) => () => void
```

- [ ] **Step 2: preload API 추가** — `src/preload.js`

`onTerminalZoom` 항목 뒤(객체를 닫는 `});` 앞)에 쉼표를 붙이고 추가:

```js
  // MCP 서버 (Claude Code)
  mcpGetStatus: () => ipcRenderer.invoke('mcp-get-status'),
  mcpUpdateConfig: (patch) => ipcRenderer.invoke('mcp-update-config', patch),
  mcpRegenerateToken: () => ipcRenderer.invoke('mcp-regenerate-token'),
  mcpRespondApproval: (id, approved) => ipcRenderer.invoke('mcp-respond-approval', { id, approved }),
  mcpReadAudit: (limit) => ipcRenderer.invoke('mcp-read-audit', { limit }),
  onMcpApprovalRequest: (callback) => {
    const handler = (event, request) => callback(request);
    ipcRenderer.on('mcp-approval-request', handler);
    return () => ipcRenderer.removeListener('mcp-approval-request', handler);
  },
  onMcpApprovalDismiss: (callback) => {
    const handler = (event, payload) => callback(payload);
    ipcRenderer.on('mcp-approval-dismiss', handler);
    return () => ipcRenderer.removeListener('mcp-approval-dismiss', handler);
  }
```

- [ ] **Step 3: main.js — import 와 상태 변수**

1번째 줄을 바꾼다:

```js
const { app, BrowserWindow, ipcMain, dialog, safeStorage, shell, Notification } = require('electron');
```

`require('./src/sftpSymlinks.js')` 줄 아래에 추가:

```js
const { createMcpController } = require('./src/mcp/controller.js');
const { registerMcpIpc } = require('./src/mcp/ipc.js');
```

`let isAppLocked = true;` 줄 아래에 추가:

```js
let mcpController = null; // Local MCP server for Claude Code (src/mcp), created once the window exists
```

- [ ] **Step 4: main.js — 세션 복호화 함수 분리**

`ipcMain.handle('load-sessions', ...)` 핸들러 전체를 아래 두 부분으로 바꾼다 (복호화 로직은 그대로 옮긴다):

```js
/** Decrypt sessions.json with the current master password. Callers check the lock state first. */
function readDecryptedSessions() {
  const sessionsPath = path.join(app.getPath('userData'), 'sessions.json');
  if (!fs.existsSync(sessionsPath)) return [];

  const sessions = JSON.parse(fs.readFileSync(sessionsPath, 'utf8'));
  return sessions.map(session => {
    // Handle legacy unencrypted sessions (migration)
    if (!session.encrypted && !session.encryptedVersion) {
      // This is a legacy session, mark for migration on next save
      return { ...session, needsMigration: true };
    }

    try {
      const decrypted = JSON.parse(
        cryptoUtil.decrypt(session.encrypted, currentMasterPassword)
      );

      const { encrypted, encryptedVersion, ...safeSession } = session;
      return {
        ...safeSession,
        ...decrypted
      };
    } catch (err) {
      console.error('Failed to decrypt session:', session.name);
      return { ...session, decryptionFailed: true };
    }
  });
}

// 세션 저장/로드 IPC (with encryption)
ipcMain.handle('load-sessions', async () => {
  if (isAppLocked || !currentMasterPassword) {
    return { success: false, error: 'App is locked', sessions: [] };
  }

  try {
    return { success: true, sessions: readDecryptedSessions() };
  } catch (err) {
    console.error('Failed to load sessions:', err);
    return { success: false, error: err.message, sessions: [] };
  }
});
```

- [ ] **Step 5: main.js — MCP 연결부 추가**

`// ==================== App Settings ====================` 줄 **앞**에 추가:

```js
// ==================== MCP Server (Claude Code) ====================

function sendToMainWindow(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isLoading()) return false;
  mainWindow.webContents.send(channel, payload);
  return true;
}

/** Ask in the app; when the window is in the background, also flash it and show a notification */
function showMcpApproval(request) {
  const delivered = sendToMainWindow('mcp-approval-request', request);
  if (delivered && !mainWindow.isFocused()) {
    mainWindow.flashFrame(true);
    mainWindow.once('focus', () => mainWindow.flashFrame(false));
    if (Notification.isSupported()) {
      const notice = new Notification({
        title: 'MCP 명령 확인 요청',
        body: `${request.sessionName}: ${request.command}`.slice(0, 200)
      });
      notice.on('click', () => { mainWindow.show(); mainWindow.focus(); });
      notice.show();
    }
  }
  return delivered;
}

function startMcp() {
  mcpController = createMcpController({
    userDataPath,
    version: app.getVersion(),
    isUnlocked: () => !isAppLocked && Boolean(currentMasterPassword),
    loadSessions: () => (isAppLocked || !currentMasterPassword ? [] : readDecryptedSessions()),
    loadFolders: () => loadFromFile(foldersFilePath, []),
    showApproval: showMcpApproval,
    dismissApproval: (id) => sendToMainWindow('mcp-approval-dismiss', { id })
  });
  mcpController.start().catch(err => console.error('Failed to start MCP server:', err));
}

registerMcpIpc(ipcMain, () => mcpController);

```

- [ ] **Step 6: main.js — 시작·잠금·저장·종료 연결**

1. `app.whenReady().then(() => {` 블록 안에서 `createWindow()` 를 호출하는 줄 바로 다음에 `startMcp();` 를 추가한다.
2. `ipcMain.handle('lock-app', ...)` 안의 `isAppLocked = true;` 다음 줄에 `mcpController?.onLocked();` 를 추가한다.
3. `ipcMain.handle('reset-master-password', ...)` 안의 `isAppLocked = true;` 다음 줄에도 `mcpController?.onLocked();` 를 추가한다.
4. `ipcMain.handle('save-sessions', ...)` 안의 `fs.writeFileSync(sessionsPath, ...)` 다음 줄에 `mcpController?.onSessionsSaved();` 를 추가한다.
5. `app.on('window-all-closed', () => {` 블록 첫 줄에 `mcpController?.shutdown().catch(() => {});` 를 추가한다.

확인: `grep -n "mcpController" main.js` 가 선언 1곳, `startMcp` 안 2곳, `registerMcpIpc` 1곳, 위 5곳을 보여야 한다.

- [ ] **Step 7: 정적 검증**

Run: `npm run typecheck && npx vitest run && npm run build`
Expected: 타입 오류 0, 전체 테스트 PASS, 빌드 성공. `out/main/src/mcp/controller.js` 가 있어야 한다.

- [ ] **Step 8: 실행 확인 (별도 인스턴스)**

`docs/brain/2026-09-29-cdp-capture-on-hidden-window.md` 의 방법으로, 사용자 프로필을 복사한 임시 프로필(`Local State` 포함)로 빌드 결과를 띄운다:

```bash
./node_modules/electron/dist/electron.exe . --user-data-dir="<scratchpad>/profile" --remote-debugging-port=9444
```

CDP `Runtime.evaluate` 로 아래를 차례로 확인한다:
1. `await window.electronAPI.mcpGetStatus()` → `success: true`, `config.enabled: false`, `running: false`
2. `await window.electronAPI.mcpUpdateConfig({ enabled: true, port: 47599 })` → `running: true`, `error: null`
3. 셸에서 `curl -s -o /dev/null -w "%{http_code}" -X POST http://127.0.0.1:47599/mcp` → `401`
4. `await window.electronAPI.mcpUpdateConfig({ port: 70000 })` → `success: false`, `error` 에 "포트"
5. `await window.electronAPI.mcpUpdateConfig({ enabled: false })` → `running: false`, 같은 curl 이 연결 실패

확인 뒤 임시 인스턴스를 종료한다 (명령줄에 `--remote-debugging-port=9444` 가 있는 PID 만 `taskkill /T /F`).

- [ ] **Step 9: 체크박스 갱신**

---

### Task 12: 세션별 "MCP 접근 허용" 스위치

**Files:**
- Modify: `src/renderer/stores/sessionStore.ts`, `src/renderer/components/Modal/ConnectModal.tsx`, `src/renderer/App.tsx`

**Interfaces:**
- Produces: 세션 데이터의 `mcpEnabled?: boolean` (저장 시 `sessions.json` 의 평문 필드. `save-sessions` 는 비밀 필드만 암호화하므로 별도 처리 불필요). Task 8 은 `mcpEnabled === true` 인 세션만 사용한다.

- [ ] **Step 1: 세션 타입** — `src/renderer/stores/sessionStore.ts`

`Session` 인터페이스의 `postConnectScript?: string` 아래에 추가:

```ts
  /** Claude Code may run commands on this session through the local MCP server */
  mcpEnabled?: boolean
```

- [ ] **Step 2: 모달 설정 타입과 기본값** — `src/renderer/components/Modal/ConnectModal.tsx`

`ConnectionConfig` 의 `postConnectScript?: string` 아래에 `mcpEnabled?: boolean` 을, `DEFAULT_CONFIG` 의 `postConnectScript: '',` 아래에 `mcpEnabled: false,` 를 추가한다.

- [ ] **Step 3: 스위치 추가** — 같은 파일, 고급 설정의 "연결 끊김 시 자동 재연결" `checkbox-group` 블록 바로 뒤

```tsx
                <div className="form-group checkbox-group">
                  <label>
                    <input
                      type="checkbox"
                      checked={config.mcpEnabled === true}
                      onChange={(e) => updateConfig('mcpEnabled', e.target.checked)}
                    />
                    <span>Claude Code(MCP)에서 이 세션 접근 허용</span>
                  </label>
                  <p className="form-hint">
                    설정 &gt; MCP 에서 서버를 켜면 Claude 가 이 세션으로 명령을 실행할 수 있습니다. 위험한 명령은 실행 전에 확인을 받습니다.
                  </p>
                </div>
```

- [ ] **Step 4: 저장 매핑과 복제** — `src/renderer/App.tsx`

1. 세션을 저장하는 매핑에서 `postConnectScript: config.postConnectScript,` 다음 줄에 `mcpEnabled: config.mcpEnabled === true,` 를 추가한다 (`grep -n "postConnectScript: config.postConnectScript" src/renderer/App.tsx` 로 위치 확인. 여러 곳이면 모두).
2. `handleDuplicateSession` 의 `setDuplicateSource({ ...session, id: undefined, name: ..., saveSession: true })` 에 `mcpEnabled: false` 를 추가한다:

```tsx
    setDuplicateSource({ ...session, id: undefined, name: `${baseName} - 복제됨`, saveSession: true, mcpEnabled: false })
```

- [ ] **Step 5: 검증**

Run: `npm run typecheck && npx vitest run && npm run build`
Expected: 모두 통과

임시 인스턴스(Task 11 Step 8 방법)에서 세션 편집 모달 > 고급 설정을 열어 스위치를 켜고 저장한 뒤, 임시 프로필의 `sessions.json` 에 해당 세션의 `"mcpEnabled": true` 가 있는지 확인한다. 세션을 복제하면 복제본의 스위치가 꺼져 있어야 한다.

- [ ] **Step 6: 체크박스 갱신**

---

### Task 13: 설정 > MCP 탭

**Files:**
- Create: `src/renderer/lib/mcpLabels.ts`, `src/renderer/lib/mcpLabels.test.ts`
- Create: `src/renderer/components/Mcp/McpSettings.tsx`, `src/renderer/components/Mcp/McpAuditList.tsx`, `src/renderer/components/Mcp/Mcp.css`
- Modify: `src/renderer/components/Settings/SettingsModal.tsx`

**Interfaces:**
- Consumes: Task 11 의 `electronAPI` MCP 멤버와 타입
- Produces (`mcpLabels.ts`, Task 14 도 씀):
  - `RISK_LABELS: Record<McpRiskLevel, string>`, `OUTCOME_LABELS: Record<McpAuditOutcome, string>`
  - `ALERT_LEVEL_OPTIONS: { value: McpAlertLevel, label: string, description: string }[]`
  - `maskToken(token: string): string`, `parsePort(text: string): number | null`
  - `secondsLeft(expiresAt: number, now: number): number`, `formatAuditTime(iso: string): string`

- [ ] **Step 1: 실패하는 테스트 작성** — `src/renderer/lib/mcpLabels.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { ALERT_LEVEL_OPTIONS, OUTCOME_LABELS, RISK_LABELS, formatAuditTime, maskToken, parsePort, secondsLeft } from './mcpLabels'

describe('mcpLabels', () => {
  it('labels every risk level and outcome', () => {
    expect(RISK_LABELS).toEqual({ low: '낮음', medium: '중간', danger: '위험', forbidden: '차단' })
    expect(Object.keys(OUTCOME_LABELS).sort()).toEqual(['approved', 'blocked', 'cancelled', 'denied', 'executed', 'expired', 'failed'])
  })

  it('offers the alert levels with danger first as the default', () => {
    expect(ALERT_LEVEL_OPTIONS.map(option => option.value)).toEqual(['danger', 'medium', 'all'])
  })

  it('masks all but the ends of a token', () => {
    expect(maskToken('ab'.repeat(32))).toBe(`abab${'•'.repeat(12)}abab`)
    expect(maskToken('short')).toBe('••••')
  })

  it('accepts only whole ports between 1024 and 65535', () => {
    expect(parsePort('47521')).toBe(47521)
    expect(parsePort(' 50000 ')).toBe(50000)
    expect(parsePort('80')).toBeNull()
    expect(parsePort('70000')).toBeNull()
    expect(parsePort('47.5')).toBeNull()
    expect(parsePort('abc')).toBeNull()
  })

  it('counts down whole seconds without going negative', () => {
    expect(secondsLeft(60_000, 0)).toBe(60)
    expect(secondsLeft(60_000, 59_001)).toBe(1)
    expect(secondsLeft(60_000, 61_000)).toBe(0)
  })

  it('formats audit times and keeps unknown text', () => {
    expect(formatAuditTime('2026-10-01T01:02:03.000Z')).toMatch(/^\d{1,2}\/\d{1,2} \d{2}:\d{2}:\d{2}$/)
    expect(formatAuditTime('nope')).toBe('nope')
  })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/renderer/lib/mcpLabels.test.ts`
Expected: FAIL (모듈 없음)

- [ ] **Step 3: 구현** — `src/renderer/lib/mcpLabels.ts`

```ts
import type { McpAlertLevel, McpAuditOutcome, McpRiskLevel } from '../types'

const MIN_PORT = 1024
const MAX_PORT = 65535
const TOKEN_EDGE = 4
const TOKEN_MASK = '•'.repeat(12)

export const RISK_LABELS: Record<McpRiskLevel, string> = {
  low: '낮음',
  medium: '중간',
  danger: '위험',
  forbidden: '차단'
}

export const OUTCOME_LABELS: Record<McpAuditOutcome, string> = {
  executed: '실행',
  approved: '허용 후 실행',
  denied: '거부',
  expired: '미응답(만료)',
  cancelled: '취소',
  blocked: '차단',
  failed: '실패'
}

export const ALERT_LEVEL_OPTIONS: { value: McpAlertLevel; label: string; description: string }[] = [
  { value: 'danger', label: '위험만 (기본)', description: '서버 상태를 바꾸는 명령과 처음 보는 명령만 확인합니다.' },
  { value: 'medium', label: '중간 이상', description: '비밀 정보 경로 읽기, 전체 탐색, 외부 요청도 확인합니다.' },
  { value: 'all', label: '모든 명령', description: 'ls 같은 조회 명령까지 모두 확인합니다.' }
]

export function maskToken(token: string): string {
  if (token.length <= TOKEN_EDGE * 2) return '••••'
  return `${token.slice(0, TOKEN_EDGE)}${TOKEN_MASK}${token.slice(-TOKEN_EDGE)}`
}

export function parsePort(text: string): number | null {
  const trimmed = text.trim()
  if (!/^\d+$/.test(trimmed)) return null
  const port = Number(trimmed)
  return port >= MIN_PORT && port <= MAX_PORT ? port : null
}

export function secondsLeft(expiresAt: number, now: number): number {
  return Math.max(0, Math.ceil((expiresAt - now) / 1000))
}

export function formatAuditTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run src/renderer/lib/mcpLabels.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: 감사 로그 표** — `src/renderer/components/Mcp/McpAuditList.tsx`

```tsx
import { useCallback, useEffect, useState } from 'react'
import { RiRefreshLine } from 'react-icons/ri'
import type { McpAuditEntry } from '../../types'
import { OUTCOME_LABELS, RISK_LABELS, formatAuditTime } from '../../lib/mcpLabels'

const AUDIT_LIMIT = 200

export function McpAuditList() {
  const [entries, setEntries] = useState<McpAuditEntry[]>([])
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const read = window.electronAPI?.mcpReadAudit
    if (typeof read !== 'function') return
    try {
      const result = await read(AUDIT_LIMIT)
      setEntries(result.entries)
      setError(result.success ? null : result.error ?? '실행 기록을 읽지 못했습니다')
    } catch {
      setError('실행 기록을 읽지 못했습니다')
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  return (
    <section className="mcp-audit">
      <div className="mcp-audit-header">
        <span className="mcp-field-label">최근 실행 기록 (최대 {AUDIT_LIMIT}건)</span>
        <button type="button" className="mcp-icon-btn" onClick={refresh} title="새로고침" aria-label="실행 기록 새로고침">
          <RiRefreshLine size={16} />
        </button>
      </div>
      {error && <p className="mcp-error" role="alert">{error}</p>}
      {entries.length === 0 ? (
        <p className="form-hint">아직 기록이 없습니다.</p>
      ) : (
        <div className="mcp-audit-scroll">
          <table className="mcp-audit-table">
            <thead>
              <tr><th>시각</th><th>세션</th><th>명령</th><th>위험도</th><th>결과</th></tr>
            </thead>
            <tbody>
              {entries.map(entry => (
                <tr key={`${entry.requestId}-${entry.time}`}>
                  <td>{formatAuditTime(entry.time)}</td>
                  <td>{entry.sessionName}</td>
                  <td><code title={entry.command}>{entry.command}</code></td>
                  <td><span className={`mcp-risk mcp-risk-${entry.level}`}>{RISK_LABELS[entry.level]}</span></td>
                  <td title={entry.error || entry.reasons.join(', ')}>
                    {OUTCOME_LABELS[entry.outcome]}
                    {entry.exitCode != null && ` (${entry.exitCode})`}
                    {entry.timedOut && ' · 시간 초과'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
```

- [ ] **Step 6: 설정 화면** — `src/renderer/components/Mcp/McpSettings.tsx`

```tsx
import { useCallback, useEffect, useState } from 'react'
import { RiEyeLine, RiEyeOffLine, RiFileCopyLine, RiRefreshLine } from 'react-icons/ri'
import { toast } from '../../stores/toastStore'
import type { McpStatus, McpStatusResult } from '../../types'
import { ALERT_LEVEL_OPTIONS, maskToken, parsePort } from '../../lib/mcpLabels'
import { McpAuditList } from './McpAuditList'
import './Mcp.css'

async function copyText(text: string, label: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    toast.success('복사됨', `${label}을(를) 복사했습니다`)
  } catch {
    toast.error('복사 실패', '클립보드에 접근할 수 없습니다')
  }
}

export function McpSettings() {
  const api = window.electronAPI
  const isSupported = typeof api?.mcpGetStatus === 'function'
  const [status, setStatus] = useState<McpStatus | null>(null)
  const [portDraft, setPortDraft] = useState('')
  const [isTokenVisible, setIsTokenVisible] = useState(false)
  const [isBusy, setIsBusy] = useState(false)

  const applyResult = useCallback((result: McpStatusResult) => {
    if (!result.success) {
      toast.error('MCP 설정', result.error)
      return
    }
    setStatus(result.status)
    setPortDraft(String(result.status.config.port))
  }, [])

  useEffect(() => {
    if (!isSupported) return
    api.mcpGetStatus!().then(applyResult).catch(() => toast.error('MCP 설정', '상태를 불러오지 못했습니다'))
  }, [api, isSupported, applyResult])

  const run = async (task: () => Promise<McpStatusResult>) => {
    setIsBusy(true)
    try {
      applyResult(await task())
    } catch {
      toast.error('MCP 설정', '요청을 처리하지 못했습니다')
    } finally {
      setIsBusy(false)
    }
  }

  if (!isSupported) return <p className="settings-section-desc">앱을 다시 시작하면 MCP 설정을 사용할 수 있습니다.</p>
  if (!status) return <p className="settings-section-desc">불러오는 중…</p>

  const { config } = status
  const shownToken = isTokenVisible ? config.token : maskToken(config.token)

  const commitPort = () => {
    const port = parsePort(portDraft)
    if (port === null) {
      toast.error('포트', '1024~65535 사이의 정수를 입력하세요')
      setPortDraft(String(config.port))
      return
    }
    if (port !== config.port) run(() => api.mcpUpdateConfig!({ port }))
  }

  const regenerate = () => {
    if (!window.confirm('토큰을 재발급하면 Claude Code 에 다시 등록해야 합니다. 계속할까요?')) return
    run(() => api.mcpRegenerateToken!())
  }

  return (
    <div className="mcp-settings">
      <div className="mcp-row">
        <label className="mcp-toggle">
          <input
            type="checkbox"
            checked={config.enabled}
            disabled={isBusy}
            onChange={(e) => run(() => api.mcpUpdateConfig!({ enabled: e.target.checked }))}
          />
          <span>MCP 서버 켜기</span>
        </label>
        <span className={`mcp-state ${status.running ? 'running' : ''}`}>
          {status.running ? `실행 중 · 127.0.0.1:${config.port}` : '꺼짐'}
        </span>
      </div>
      {status.error && <p className="mcp-error" role="alert">{status.error}</p>}

      <div className="mcp-field">
        <label className="mcp-field-label" htmlFor="mcp-port">포트</label>
        <input
          id="mcp-port"
          className="mcp-port-input"
          inputMode="numeric"
          value={portDraft}
          disabled={isBusy}
          onChange={(e) => setPortDraft(e.target.value)}
          onBlur={commitPort}
          onKeyDown={(e) => { if (e.key === 'Enter') commitPort() }}
        />
      </div>

      <fieldset className="mcp-field">
        <legend className="mcp-field-label">확인 창을 띄울 명령</legend>
        {ALERT_LEVEL_OPTIONS.map(option => (
          <label key={option.value} className="mcp-radio">
            <input
              type="radio"
              name="mcp-alert-level"
              checked={config.alertLevel === option.value}
              disabled={isBusy}
              onChange={() => run(() => api.mcpUpdateConfig!({ alertLevel: option.value }))}
            />
            <span className="mcp-radio-label">{option.label}</span>
            <span className="mcp-radio-desc">{option.description}</span>
          </label>
        ))}
        <p className="form-hint">위험한 명령은 어떤 설정에서도 확인 창을 띄우고, 시스템 종료·루트 삭제 같은 명령은 항상 차단합니다.</p>
      </fieldset>

      <div className="mcp-field">
        <span className="mcp-field-label">접속 토큰</span>
        <div className="mcp-token">
          <code>{shownToken}</code>
          <button type="button" className="mcp-icon-btn" onClick={() => setIsTokenVisible(visible => !visible)} aria-label={isTokenVisible ? '토큰 숨기기' : '토큰 보기'} title={isTokenVisible ? '숨기기' : '보기'}>
            {isTokenVisible ? <RiEyeOffLine size={16} /> : <RiEyeLine size={16} />}
          </button>
          <button type="button" className="mcp-icon-btn" onClick={() => copyText(config.token, '토큰')} aria-label="토큰 복사" title="복사">
            <RiFileCopyLine size={16} />
          </button>
          <button type="button" className="mcp-icon-btn" onClick={regenerate} disabled={isBusy} aria-label="토큰 재발급" title="재발급">
            <RiRefreshLine size={16} />
          </button>
        </div>
      </div>

      <div className="mcp-field">
        <span className="mcp-field-label">Claude Code 등록 명령</span>
        <div className="mcp-command">
          <pre>{status.registerCommand.replace(config.token, shownToken)}</pre>
          <button type="button" className="mcp-icon-btn" onClick={() => copyText(status.registerCommand, '등록 명령')} aria-label="등록 명령 복사" title="복사">
            <RiFileCopyLine size={16} />
          </button>
        </div>
        <p className="form-hint">터미널에서 실행하면 Claude Code 에 등록됩니다. 세션 편집 &gt; 고급 설정에서 "MCP 접근 허용"을 켠 세션만 Claude 에게 보입니다.</p>
      </div>

      <McpAuditList />
    </div>
  )
}
```

- [ ] **Step 7: 스타일** — `src/renderer/components/Mcp/Mcp.css`

```css
/* MCP settings tab and approval dialog. Square corners and tokens follow variables.css. */
.mcp-settings {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.mcp-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.mcp-toggle,
.mcp-radio {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}

.mcp-toggle input,
.mcp-radio input {
  accent-color: var(--accent);
}

.mcp-state {
  font-size: 13px;
  color: var(--text-muted);
}

.mcp-state.running {
  color: var(--success);
  font-weight: 600;
}

.mcp-error {
  margin: 0;
  padding: 8px 10px;
  border-left: 3px solid var(--error);
  background: color-mix(in srgb, var(--error) 12%, transparent);
  color: var(--error-text);
  font-size: 13px;
}

.mcp-field {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  border: none;
}

.mcp-field-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
}

.mcp-port-input {
  width: 120px;
  padding: 6px 8px;
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  font-family: var(--font-mono);
}

.mcp-radio {
  flex-wrap: wrap;
}

.mcp-radio-label {
  font-size: 14px;
  color: var(--text-primary);
}

.mcp-radio-desc {
  flex-basis: 100%;
  padding-left: 24px;
  font-size: 13px;
  color: var(--text-muted);
}

.mcp-token,
.mcp-command {
  display: flex;
  align-items: flex-start;
  gap: 6px;
}

.mcp-token code,
.mcp-command pre {
  flex: 1;
  min-width: 0;
  margin: 0;
  padding: 8px 10px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  font-family: var(--font-mono);
  font-size: 13px;
  color: var(--text-primary);
  white-space: pre-wrap;
  word-break: break-all;
}

.mcp-icon-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  background: transparent;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  cursor: pointer;
}

.mcp-icon-btn:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--text-primary);
}

.mcp-icon-btn:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

.mcp-audit-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.mcp-audit-scroll {
  max-height: 280px;
  overflow: auto;
  border: 1px solid var(--border);
}

.mcp-audit-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.mcp-audit-table th,
.mcp-audit-table td {
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
  text-align: left;
  vertical-align: top;
}

.mcp-audit-table th {
  position: sticky;
  top: 0;
  background: var(--bg-secondary);
  color: var(--text-secondary);
  font-weight: 600;
}

.mcp-audit-table code {
  display: block;
  max-width: 280px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
}

.mcp-risk {
  display: inline-block;
  padding: 1px 6px;
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
}

.mcp-risk-low {
  background: color-mix(in srgb, var(--success) 18%, transparent);
  color: var(--success);
}

.mcp-risk-medium {
  background: color-mix(in srgb, var(--warning) 20%, transparent);
  color: var(--warning);
}

.mcp-risk-danger,
.mcp-risk-forbidden {
  background: color-mix(in srgb, var(--error) 20%, transparent);
  color: var(--error-text);
}

/* Approval dialog */
.mcp-approval {
  width: min(560px, calc(100vw - 32px));
  padding: 20px;
}

.mcp-approval-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;
}

.mcp-approval-timer {
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  color: var(--warning);
}

.mcp-approval-fields {
  display: grid;
  grid-template-columns: 64px 1fr;
  gap: 8px 12px;
  margin: 0 0 12px;
}

.mcp-approval-fields dt {
  font-size: 13px;
  color: var(--text-muted);
}

.mcp-approval-fields dd {
  margin: 0;
  min-width: 0;
  font-size: 14px;
  color: var(--text-primary);
}

.mcp-approval-folder {
  color: var(--text-muted);
}

.mcp-approval-command {
  margin: 0;
  padding: 8px 10px;
  max-height: 160px;
  overflow: auto;
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  font-family: var(--font-mono);
  font-size: 13px;
  white-space: pre-wrap;
  word-break: break-all;
}

.mcp-approval-reasons {
  margin: 6px 0 0;
  padding-left: 18px;
  font-size: 13px;
  color: var(--text-secondary);
}

.mcp-approval-hint {
  margin: 0 0 16px;
  font-size: 13px;
  color: var(--text-muted);
}

.mcp-approval-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.mcp-approve-btn {
  padding: 8px 16px;
  background: var(--error);
  border: 1px solid var(--error);
  border-radius: var(--radius-sm);
  color: var(--on-accent);
  font-weight: 600;
  cursor: pointer;
}

.mcp-approve-btn:hover {
  filter: brightness(1.1);
}

.mcp-approve-btn:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
```

- [ ] **Step 8: 설정 모달에 탭 추가** — `src/renderer/components/Settings/SettingsModal.tsx`

아이콘 import 에 `RiPlugLine` 을 추가하고, `import { FontSizeControl } from './FontSizeControl'` 아래에 `import { McpSettings } from '../Mcp/McpSettings'` 를 추가한다.

`backup` 탭의 `</Tabs.Trigger>` 뒤에 추가:

```tsx
                    <Tabs.Trigger value="mcp" className="settings-tab-trigger">
                      <RiPlugLine size={18} />
                      MCP
                    </Tabs.Trigger>
```

`backup` 탭의 `</Tabs.Content>` 뒤에 추가:

```tsx
                  <Tabs.Content value="mcp" className="settings-tab-content">
                    <div className="settings-content">
                      <section className="settings-section">
                        <h3 className="settings-section-title">
                          <RiPlugLine size={18} />
                          MCP 서버 (Claude Code)
                        </h3>
                        <p className="settings-section-desc">
                          Claude Code 가 허용한 세션으로 서버를 조회할 수 있게 합니다. 비밀번호는 Claude 에게 전달되지 않습니다.
                        </p>
                        <McpSettings />
                      </section>
                    </div>
                  </Tabs.Content>
```

- [ ] **Step 9: 검증**

Run: `npm run typecheck && npx vitest run && npm run build`
Expected: 모두 통과

임시 인스턴스에서 설정 > MCP 탭을 열고 CDP 로 확인한다: 서버 켜기 → "실행 중 · 127.0.0.1:<포트>", 잘못된 포트 입력 → 오류 토스트와 원래 값 복원, 토큰 보기/숨기기, 등록 명령의 토큰이 가려져 표시됨, 실행 기록 표가 보임. 가능하면 화면을 캡처한다 (창이 가려져 캡처가 멈추면 DOM 확인으로 대신하고 그 사실을 기록).

- [ ] **Step 10: 체크박스 갱신**

---

### Task 14: 확인 창

**Files:**
- Create: `src/renderer/components/Mcp/McpApprovalDialog.tsx`
- Modify: `src/renderer/App.tsx`

**Interfaces:**
- Consumes: `onMcpApprovalRequest`, `onMcpApprovalDismiss`, `mcpRespondApproval` (Task 11), `RISK_LABELS`, `secondsLeft` (Task 13), `Mcp.css`
- 동작: main 은 한 번에 요청 하나만 보낸다. 창을 닫거나(Esc, 바깥 클릭) 거부를 누르면 `approved: false`. 기본 포커스는 거부.

- [ ] **Step 1: 구현** — `src/renderer/components/Mcp/McpApprovalDialog.tsx`

```tsx
import { useEffect, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import type { McpApprovalRequest } from '../../types'
import { RISK_LABELS, secondsLeft } from '../../lib/mcpLabels'
import './Mcp.css'

const TICK_MS = 250

/** "May Claude run this?" dialog for commands that the MCP server holds for approval */
export function McpApprovalDialog() {
  const [request, setRequest] = useState<McpApprovalRequest | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const denyRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const api = window.electronAPI
    if (typeof api?.onMcpApprovalRequest !== 'function') return
    const offRequest = api.onMcpApprovalRequest((next) => {
      setNow(Date.now())
      setRequest(next)
    })
    const offDismiss = api.onMcpApprovalDismiss?.(({ id }) => {
      setRequest(current => (current?.id === id ? null : current))
    })
    return () => {
      offRequest()
      offDismiss?.()
    }
  }, [])

  useEffect(() => {
    if (!request) return
    const timer = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(timer)
  }, [request])

  if (!request) return null

  const respond = (approved: boolean) => {
    window.electronAPI.mcpRespondApproval?.(request.id, approved)
    setRequest(null)
  }
  const remaining = secondsLeft(request.expiresAt, now)

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) respond(false) }}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content
          className="modal-content mcp-approval"
          aria-describedby="mcp-approval-command"
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            denyRef.current?.focus()
          }}
        >
          <div className="mcp-approval-header">
            <Dialog.Title className="modal-title">MCP 명령 실행 요청</Dialog.Title>
            <span className="mcp-approval-timer">남은 시간 {remaining}초</span>
          </div>
          <dl className="mcp-approval-fields">
            <dt>세션</dt>
            <dd>
              {request.sessionName}
              {request.folder && <span className="mcp-approval-folder"> ({request.folder})</span>}
            </dd>
            <dt>위치</dt>
            <dd><code>{request.cwd ?? '홈 디렉터리 (첫 접속)'}</code></dd>
            <dt>명령</dt>
            <dd><pre id="mcp-approval-command" className="mcp-approval-command">{request.command}</pre></dd>
            <dt>위험도</dt>
            <dd>
              <span className={`mcp-risk mcp-risk-${request.level}`}>{RISK_LABELS[request.level]}</span>
              {request.reasons.length > 0 && (
                <ul className="mcp-approval-reasons">
                  {request.reasons.map(reason => <li key={reason}>{reason}</li>)}
                </ul>
              )}
            </dd>
          </dl>
          <p className="mcp-approval-hint">Claude Code 가 요청한 명령입니다. 내용을 확인한 뒤 허용하세요. 응답하지 않으면 시간이 지나 자동으로 거부됩니다.</p>
          <div className="mcp-approval-actions">
            <button ref={denyRef} type="button" className="btn-secondary" onClick={() => respond(false)}>거부</button>
            <button type="button" className="mcp-approve-btn" onClick={() => respond(true)}>허용</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
```

- [ ] **Step 2: 마운트** — `src/renderer/App.tsx`

import 추가: `import { McpApprovalDialog } from './components/Mcp/McpApprovalDialog'`
`<Footer />` 바로 다음 줄에 `<McpApprovalDialog />` 를 추가한다.

- [ ] **Step 3: 검증**

Run: `npm run typecheck && npx vitest run && npm run build`
Expected: 모두 통과

임시 인스턴스에서, 테스트용 세션 하나를 `mcpEnabled: true` 로 만들고 MCP 서버를 켠 뒤 셸에서 SDK 없이 직접 요청을 보낸다 (토큰은 `mcpGetStatus()` 로 확인):

```bash
curl -s -X POST http://127.0.0.1:47599/mcp -H "Authorization: Bearer <토큰>" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"run_command","arguments":{"session":"<세션 id>","command":"rm nothing.txt"}}}'
```

CDP 로 `.mcp-approval` 이 뜨는지, 포커스가 "거부" 버튼에 있는지(`document.activeElement.textContent === '거부'`), 남은 시간이 줄어드는지 확인한 뒤 "거부"를 클릭한다. curl 응답에 "거부"가 들어 있어야 한다. 같은 요청을 다시 보내고 60초 동안 응답하지 않으면 창이 닫히고 curl 응답에 "승인되지 않아"가 들어 있어야 한다.

- [ ] **Step 4: 체크박스 갱신**

---

### Task 15: 실제 Claude Code 연동 확인과 문서

**Files:**
- Modify: `CLAUDE.md`
- Create (버림, scratchpad 에만): `test-ssh-server.cjs`

- [ ] **Step 1: 테스트용 SSH 서버** — scratchpad 의 `test-ssh-server.cjs` (프로젝트에 넣지 않음)

```js
// Throwaway SSH server for the MCP end-to-end check: password "test", commands run in Git Bash inside ROOT.
const { Server, utils } = require('<프로젝트 경로>/node_modules/ssh2')
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, 'ssh-root')
const BASH = 'C:/Program Files/Git/bin/bash.exe'
fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true })
fs.writeFileSync(path.join(ROOT, 'logs', 'app.log'), 'INFO start\nERROR db timeout\n')

const hostKey = utils.generateKeyPairSync('ed25519').private

new Server({ hostKeys: [hostKey] }, (client) => {
  client.on('authentication', (ctx) => (ctx.method === 'password' && ctx.password === 'test' ? ctx.accept() : ctx.reject(['password'])))
  client.on('session', (accept) => {
    const session = accept()
    session.on('exec', (acceptExec, reject, info) => {
      const stream = acceptExec()
      const child = spawn(BASH, ['-c', info.command], { cwd: ROOT, env: { ...process.env, HOME: ROOT } })
      child.stdout.pipe(stream, { end: false })
      child.stderr.pipe(stream.stderr, { end: false })
      child.on('close', (code) => { stream.exit(code ?? 1); stream.end() })
      stream.on('close', () => child.kill())
    })
  })
  client.on('error', () => {})
}).listen(2222, '127.0.0.1', () => console.log('test ssh server on 127.0.0.1:2222'))
```

Run (백그라운드): `node test-ssh-server.cjs`

- [ ] **Step 2: 앱 준비**

임시 프로필로 빌드 결과를 띄우고(Task 11 Step 8), CDP 로:
1. `loadSessions()` 결과에 `{ id: 'e2e', name: 'E2E Test', host: '127.0.0.1', port: 2222, username: 'tester', authType: 'password', password: 'test', mcpEnabled: true }` 를 더해 `saveSessions()` 후 페이지 새로고침
2. `mcpUpdateConfig({ enabled: true, port: 47599 })` (사용자 실제 앱의 기본 포트 47521 과 겹치지 않게)
3. `mcpGetStatus()` 로 등록 명령과 토큰 확보

- [ ] **Step 3: Claude Code 등록 — 사용자 승인 필요**

`claude mcp add` 는 사용자의 `~/.claude.json` 을 바꾼다. **실행 전에 사용자에게 묻는다.** 승인되면 scratchpad 디렉터리에서:

```bash
claude mcp add --transport http my-ssh-client-e2e http://127.0.0.1:47599/mcp --header "Authorization: Bearer <토큰>" -s local
claude mcp list
```

Expected: `my-ssh-client-e2e` 가 `✓ Connected`

- [ ] **Step 4: 조회 흐름**

```bash
claude -p "my-ssh-client-e2e 의 list_sessions 를 호출한 뒤, 'E2E Test' 세션에서 cd 로 logs 에 들어가 run_command 로 'ls -al' 과 'grep ERROR app.log' 를 실행하고 결과를 그대로 보여줘" --allowedTools "mcp__my-ssh-client-e2e"
```

Expected: 세션 목록에 호스트·계정이 없고, `app.log` 목록과 `ERROR db timeout` 이 출력된다. 설정 > MCP 실행 기록에 3건(cd 1, run_command 2)이 `실행` 으로 남는다.

- [ ] **Step 5: 확인 창 흐름**

1. `claude -p "... 'E2E Test' 세션에서 run_command 로 'rm logs/app.log' 를 실행해줘" --allowedTools "mcp__my-ssh-client-e2e"` 를 백그라운드로 실행 → CDP 로 확인 창이 뜨는지 확인 → "거부" 클릭 → `ssh-root/logs/app.log` 가 남아 있고 Claude 출력에 거부가 언급되는지 확인
2. 같은 방식으로 `touch logs/new.txt` 를 요청 → "허용" → `ssh-root/logs/new.txt` 생성 확인
3. `rm -rf /` 요청 → 확인 창 없이 차단, 실행 기록에 `차단`
4. **Review Focus 1 확인**: `rm logs/app.log` 를 요청하고 확인 창이 뜬 상태에서 `claude` 프로세스를 강제 종료 → 확인 창이 닫히는지(연결 종료 → 취소) 확인. 닫히지 않으면 "허용"을 눌러 보고 파일이 지워지는지 기록한다. 지워진다면 이 계획에 후속 작업으로 적는다.
5. **Claude Code 도구 시간 제한 확인**: 확인 창을 50초 동안 두었다가 허용 → Claude 가 결과를 받는지 기록한다. Claude Code 쪽 시간 제한에 먼저 걸리면 그 값을 기록하고, 확인 창 제한(60초)을 그보다 짧게 조정할지 사용자와 상의한다.

- [ ] **Step 6: 정리**

```bash
claude mcp remove my-ssh-client-e2e -s local
```

테스트 SSH 서버와 임시 앱 인스턴스를 종료하고, 임시 프로필 폴더(암호화된 세션과 `Local State` 포함)는 사용자에게 알린 뒤 삭제한다.

- [ ] **Step 7: CLAUDE.md 갱신** — `## Important Patterns` 아래에 추가

```markdown
### MCP Server (Claude Code)
`src/mcp/` 에 로컬 MCP 서버가 있다. 설정 > MCP 에서 켜면 `127.0.0.1:<포트>/mcp` (Streamable HTTP, stateless) 로 열린다.
- 도구: `list_sessions`, `cd`, `run_command`. 세션 편집 > 고급 설정의 "MCP 접근 허용"(`mcpEnabled`)을 켠 세션만 보인다.
- 명령은 `commandPolicy.js` 가 낮음/중간/위험/절대 차단으로 판정한다. 처음 보는 명령은 위험. 위험은 항상 앱 확인 창, 절대 차단은 실행 불가.
- 설정은 `userData/mcp.json`(main 전용), 감사 로그는 `userData/mcp-audit.log`.
- Electron 28(Node 18)에는 `globalThis.crypto` 가 없어서 `src/mcp/sdk.js` 가 채운 뒤 SDK 를 불러온다.
- `src/mcp` 는 번들되지 않고 `electron.vite.config.ts` 가 `out/main/src/mcp` 로 복사한다.
```

- [ ] **Step 8: 최종 검증**

Run: `npm run typecheck && npx vitest run && npm run build`
Expected: 타입 오류 0, 전체 테스트 PASS, 빌드 성공

- [ ] **Step 8-1: 커버리지 확인 (설계 문서 6장 7번)**

커버리지 도구(`@vitest/coverage-v8`)가 아직 설치되어 있지 않다. 개발 의존성 추가는 사용자에게 먼저 묻는다. 승인되면:

```bash
npm install --save-dev @vitest/coverage-v8@3
npx vitest run --coverage --coverage.include="src/mcp/**" --coverage.exclude="src/mcp/**/*.test.js"
```

Expected: `src/mcp` 전체 Lines 80% 이상. 미달인 파일은 빠진 분기에 테스트를 추가한다. 사용자가 설치를 원하지 않으면 이 단계를 건너뛰었다고 보고에 적는다.

- [ ] **Step 9: 체크박스 갱신, 사용자에게 결과 보고** (커밋 여부는 사용자에게 묻는다)

---

### Task 16: MCP 활동 화면 (실시간)

> 2026-10-01 사용자 요청으로 추가. **실행 순서: Task 14 다음, Task 15 앞** (Task 15 의 실제 연동 확인이 이 화면까지 검증하도록).

**목적:** AI 가 MCP 로 지금 무엇을 하고 있는지 실시간으로 보여 준다. 사용자 승인 설계:
- 하단 상태 표시줄에 `MCP · 확인 대기 1 · 실행 중 2` 같은 표시, 클릭하면 오른쪽 활동 패널이 열린다
- 요청마다 시각·세션·명령·위험도·상태(`확인 대기`/`실행 중`/`완료`/`시간 초과`/`거부`/`미응답(만료)`/`취소`/`차단`/`실패`), 펼치면 Claude 에게 돌려준 출력과 판단 근거
- 확인 대기·실행 중인 요청에는 **중지** 버튼 (취소 신호 전달)
- 출력은 **디스크에 저장하지 않고 메모리에만 최근 100건** (출력에 비밀 정보가 섞일 수 있음). 무엇을 실행했는지는 기존 감사 로그에 남는다.

**Files:**
- Create: `src/mcp/signals.js` (+ test) — `combineSignals` 를 server.js 에서 옮겨 공유
- Create: `src/mcp/activityLog.js` (+ test)
- Modify: `src/mcp/server.js` (combineSignals 를 signals.js 에서 가져오기), `src/mcp/tools.js` (+ test), `src/mcp/controller.js` (+ test), `src/mcp/ipc.js` (+ test), `main.js`, `src/preload.js`, `src/renderer/types/index.ts`
- Create: `src/renderer/lib/mcpActivity.ts` (+ test), `src/renderer/stores/mcpActivityStore.ts`, `src/renderer/hooks/useMcpActivityFeed.ts`, `src/renderer/components/Mcp/McpActivityIndicator.tsx`, `src/renderer/components/Mcp/McpActivityPanel.tsx`, `src/renderer/components/Mcp/McpActivity.css`
- Modify: `src/renderer/components/Footer/Footer.tsx` (표시 추가)

**Interfaces:**
- Activity item (main → renderer, 같은 모양):
  `{ id, time, sessionId, sessionName, command, level, reasons, state, startedAt, finishedAt, exitCode?, timedOut?, truncated?, error?, output? }`
  - `id` 는 감사 로그의 `requestId`, `time` 은 ISO 문자열, `startedAt`/`finishedAt` 은 ms (`finishedAt` 은 진행 중이면 `null`)
  - `state`: `'waiting' | 'running' | 'done' | 'timeout' | 'denied' | 'expired' | 'cancelled' | 'blocked' | 'failed'`
  - `output`: 끝났을 때 Claude 에게 돌려준 텍스트 그대로 (게이트웨이가 이미 64KB 로 자름). `GatewayError.detail` 은 절대 넣지 않는다.
- `createActivityLog({ emit?, now?, max? = 100 })` → `{ begin(fields, { cancel }?), update(id, patch), cancel(id): boolean, list(): item[] }` — `list()` 는 최신순
- `combineSignals(signals: (AbortSignal|undefined|null)[]): AbortSignal`
- `createToolHandlers({ ..., activity? })` — `activity` 를 넘기지 않으면 아무 일도 하지 않는 기본값
- controller: `createMcpController({ ..., emitActivity })` → 추가 메서드 `listActivity(): item[]`, `cancelActivity(id): boolean`
- IPC: `mcp-list-activity` → `{ success: true, items }`, `mcp-cancel-activity` (`{ id }`) → `{ success: boolean }`; main → renderer 채널 `mcp-activity` (item)
- preload: `mcpListActivity(): Promise<{ success: boolean, items: McpActivityItem[] }>`, `mcpCancelActivity(id): Promise<{ success: boolean }>`, `onMcpActivity(cb): () => void`

- [ ] **Step 1: 신호 결합 공유 모듈** — 테스트 먼저 (`src/mcp/signals.test.js`)

```js
import { describe, it, expect } from 'vitest'
import signalsModule from './signals.js'

const { combineSignals } = signalsModule

describe('combineSignals', () => {
  it('aborts when any input aborts', () => {
    const a = new AbortController()
    const b = new AbortController()
    const combined = combineSignals([a.signal, null, b.signal])
    expect(combined.aborted).toBe(false)
    b.abort()
    expect(combined.aborted).toBe(true)
  })

  it('starts aborted when an input already is', () => {
    const a = new AbortController()
    a.abort()
    expect(combineSignals([a.signal]).aborted).toBe(true)
  })

  it('never aborts with no inputs', () => {
    expect(combineSignals([undefined]).aborted).toBe(false)
  })
})
```

구현 (`src/mcp/signals.js`): server.js 의 `combineSignals` 를 그대로 옮기고 `module.exports = { combineSignals }`. server.js 는 `const { combineSignals } = require('./signals.js')` 로 바꾸고 자체 정의를 지운다. `npx vitest run src/mcp/signals.test.js src/mcp/server.test.js` 통과 확인.

- [ ] **Step 2: 활동 기록** — 테스트 먼저 (`src/mcp/activityLog.test.js`)

```js
import { describe, it, expect } from 'vitest'
import activityModule from './activityLog.js'

const { createActivityLog } = activityModule

function setup(max) {
  const emitted = []
  let clock = 1000
  const log = createActivityLog({ emit: (item) => emitted.push(item), now: () => clock, ...(max ? { max } : {}) })
  return { log, emitted, tick: (ms) => { clock += ms } }
}

const base = (id, state = 'running') => ({ id, time: 't', sessionId: 's1', sessionName: 'dev', command: 'ls', level: 'low', reasons: [], state })

describe('createActivityLog', () => {
  it('records a request and publishes it', () => {
    const { log, emitted } = setup()
    log.begin(base('r1'))
    expect(log.list()).toEqual([{ ...base('r1'), startedAt: 1000, finishedAt: null }])
    expect(emitted).toHaveLength(1)
  })

  it('updates a request and stamps the finish time once', () => {
    const { log, emitted, tick } = setup()
    log.begin(base('r1', 'waiting'))
    log.update('r1', { state: 'running' })
    tick(500)
    log.update('r1', { state: 'done', exitCode: 0, output: 'ok' })
    tick(500)
    log.update('r1', { output: 'ok!' })
    expect(log.list()[0]).toMatchObject({ state: 'done', exitCode: 0, output: 'ok!', startedAt: 1000, finishedAt: 1500 })
    expect(emitted.map(item => item.state)).toEqual(['waiting', 'running', 'done', 'done'])
  })

  it('stamps the finish time for a request that starts finished', () => {
    const { log } = setup()
    log.begin(base('r1', 'blocked'))
    expect(log.list()[0].finishedAt).toBe(1000)
  })

  it('keeps the newest entries up to the limit', () => {
    const { log } = setup(2)
    log.begin(base('r1'))
    log.begin(base('r2'))
    log.begin(base('r3'))
    expect(log.list().map(item => item.id)).toEqual(['r3', 'r2'])
  })

  it('cancels only active requests, once', () => {
    const { log } = setup()
    let stops = 0
    log.begin(base('r1'), { cancel: () => { stops++ } })
    expect(log.cancel('r1')).toBe(true)
    expect(log.cancel('r1')).toBe(false)
    expect(stops).toBe(1)
    log.begin(base('r2'), { cancel: () => { stops++ } })
    log.update('r2', { state: 'done' })
    expect(log.cancel('r2')).toBe(false)
    expect(log.cancel('nope')).toBe(false)
  })

  it('ignores updates for unknown requests', () => {
    const { log, emitted } = setup()
    log.update('nope', { state: 'done' })
    expect(emitted).toHaveLength(0)
  })

  it('keeps working when publishing fails', () => {
    const log = createActivityLog({ emit: () => { throw new Error('window gone') } })
    expect(() => log.begin(base('r1'))).not.toThrow()
    expect(log.list()).toHaveLength(1)
  })
})
```

구현 (`src/mcp/activityLog.js`):

```js
// In-memory record of recent MCP requests for the live activity panel.
// Outputs can contain secrets, so nothing here is ever written to disk.
const DEFAULT_MAX = 100
const ACTIVE_STATES = new Set(['waiting', 'running'])

function createActivityLog({ emit = () => {}, now = () => Date.now(), max = DEFAULT_MAX } = {}) {
  let items = []
  const cancellers = new Map()

  function publish(item) {
    try {
      emit(item)
    } catch {
      // The window may be gone; the list stays available for the next listActivity()
    }
  }

  function begin(fields, { cancel } = {}) {
    const item = { ...fields, startedAt: now(), finishedAt: ACTIVE_STATES.has(fields.state) ? null : now() }
    items = [item, ...items.filter(existing => existing.id !== item.id)].slice(0, max)
    const kept = new Set(items.map(existing => existing.id))
    for (const id of cancellers.keys()) if (!kept.has(id)) cancellers.delete(id)
    if (cancel && ACTIVE_STATES.has(item.state)) cancellers.set(item.id, cancel)
    publish(item)
    return item.id
  }

  function update(id, patch) {
    const current = items.find(item => item.id === id)
    if (!current) return
    const state = patch.state || current.state
    const finished = !ACTIVE_STATES.has(state)
    const next = { ...current, ...patch, finishedAt: finished ? (current.finishedAt ?? now()) : null }
    items = items.map(item => (item.id === id ? next : item))
    if (finished) cancellers.delete(id)
    publish(next)
  }

  function cancel(id) {
    const stop = cancellers.get(id)
    if (!stop) return false
    cancellers.delete(id)
    stop()
    return true
  }

  return { begin, update, cancel, list: () => items }
}

module.exports = { createActivityLog }
```

- [ ] **Step 3: tools.js 에 활동 기록 연결** — 테스트 먼저 (`src/mcp/tools.test.js` 에 추가)

`setup()` 이 `activity` 를 받아 `createToolHandlers` 에 넘기도록 하고(기본값은 넘기지 않음), 아래 테스트를 추가한다. 실제 `createActivityLog` 를 써서 `list()` 로 확인한다.

1. 조회 명령: 상태가 `running` → `done` 순서로 발행되고, 끝난 항목의 `output` 에 `'종료 코드: 0'` 이 들어 있다. `id` 는 감사 로그의 `requestId` 와 같다.
2. 위험 명령 승인: `waiting` → `running` → `done` 순서.
3. 거부/만료/취소: 끝난 상태가 각각 `denied`/`expired`/`cancelled`.
4. 차단 명령: 항목 하나가 처음부터 `blocked` 로 기록되고 `finishedAt` 이 있다.
5. 게이트웨이 실패: `failed`, `error` 는 `userMessage`, `output` 과 항목 어디에도 `detail` 문자열이 없다.
6. 결과 플래그: `timedOut: true` 면 `timeout`, `cancelled: true` 면 `cancelled`.
7. **중지 버튼 (확인 대기 중)**: 승인 요청이 `options.signal` 의 abort 를 기다렸다가 `'cancelled'` 를 돌려주는 가짜 브로커를 쓰고, 요청이 `waiting` 이 되면 `activity.cancel(id)` → 결과는 isError, 게이트웨이 호출 없음, 상태 `cancelled`.
8. **중지 버튼 (실행 중)**: `gateway.run` 이 받은 `options.signal` 이 `activity.cancel(id)` 뒤에 aborted 인지 확인.
9. `activity` 를 넘기지 않아도 기존 테스트가 모두 그대로 통과한다.

구현 규칙 (`src/mcp/tools.js`):
- `createToolHandlers` 에 `activity = NO_ACTIVITY` 인자 추가. `const NO_ACTIVITY = { begin() {}, update() {}, cancel() { return false } }`.
- 차단: 감사 로그를 쓴 직후 `activity.begin({ ...activityFields(base), state: 'blocked', output: <돌려줄 텍스트> })`.
- 시작 감사 로그를 쓴 직후: `const stop = new AbortController()`, `const requestSignal = combineSignals([signal, stop.signal])` (signals.js), `activity.begin({ ...activityFields(base), state: 'running' }, { cancel: () => stop.abort() })`. 이후 승인 요청, 승인 뒤 중단 확인, `perform` 에는 모두 `requestSignal` 을 쓴다.
- 확인이 필요하면 승인 요청 직전에 `activity.update(id, { state: 'waiting' })`, `'approved'` 를 받으면 `activity.update(id, { state: 'running' })`.
- 끝내는 모든 경로(거부·만료·취소·잠김·세션 변경·성공·실패)에서 감사 로그 끝 기록과 같은 시점에 `activity.update(id, { state, exitCode?, timedOut?, truncated?, error?, output })`. `state` 는 감사 `outcome` 에서: `executed`/`approved` → 결과에 `cancelled` 면 `cancelled`, `timedOut` 이면 `timeout`, 아니면 `done`; 그 밖의 outcome 은 같은 이름. `output` 은 그 경로가 돌려주는 텍스트.
- `activityFields(base)` = `{ id: base.requestId, time: new Date().toISOString(), sessionId, sessionName, command, level, reasons }` (base 의 값 그대로).
- 활동 기록 호출이 예외를 던져도 명령 처리와 감사 로그에는 영향이 없어야 한다 (`activityLog` 는 던지지 않지만, 주입된 가짜가 던지는 경우를 위해 tools.js 쪽 호출도 try/catch 로 감싼다).

- [ ] **Step 4: 컨트롤러와 IPC** — 테스트 먼저

`controller.test.js` 에 추가:
- `createMcpController` 에 `emitActivity` 를 넘기면, 활동 항목이 생길 때 그 함수가 호출된다 (deps 로 `createToolHandlers` 대신 실제 경로를 쓰기 어렵다면, deps 에 `activity` 를 주입할 수 있게 하고 `listActivity()` / `cancelActivity(id)` 가 그 객체로 위임되는지 확인).
- `onLocked()` 가 활동 기록을 지우지 않는다 (잠금 뒤에도 무엇이 실행됐는지 보여야 함).

`ipc.test.js` 에 추가:
- `mcp-list-activity` → `{ success: true, items }`; 컨트롤러가 없으면 `{ success: false, items: [] }`
- `mcp-cancel-activity` 는 문자열 `id` 만 받는다 (`{ id: 5 }` → `{ success: false }`)

구현:
- controller: `const activity = deps.activity || createActivityLog({ emit: (item) => { try { emitActivity && emitActivity(item) } catch {} } })` 를 만들고 `createToolHandlers({ ..., activity })` 에 넘긴다. 반환 객체에 `listActivity: () => activity.list()`, `cancelActivity: (id) => activity.cancel(id)` 추가.
- ipc: 위 두 채널.

- [ ] **Step 5: main.js 와 preload**
- `startMcp()` 의 `createMcpController({...})` 에 `emitActivity: (item) => sendToMainWindow('mcp-activity', item)` 추가.
- preload 의 MCP 블록에 추가:

```js
  mcpListActivity: () => ipcRenderer.invoke('mcp-list-activity'),
  mcpCancelActivity: (id) => ipcRenderer.invoke('mcp-cancel-activity', { id }),
  onMcpActivity: (callback) => {
    const handler = (event, item) => callback(item);
    ipcRenderer.on('mcp-activity', handler);
    return () => ipcRenderer.removeListener('mcp-activity', handler);
  },
```

- `src/renderer/types/index.ts`: 

```ts
export type McpActivityState = 'waiting' | 'running' | 'done' | 'timeout' | 'denied' | 'expired' | 'cancelled' | 'blocked' | 'failed'

export interface McpActivityItem {
  id: string
  time: string
  sessionId: string
  sessionName: string
  command: string
  level: McpRiskLevel
  reasons: string[]
  state: McpActivityState
  startedAt: number
  finishedAt: number | null
  exitCode?: number | null
  timedOut?: boolean
  truncated?: boolean
  error?: string
  output?: string
}
```

`electronAPI` 에: `mcpListActivity?: () => Promise<{ success: boolean; items: McpActivityItem[] }>`, `mcpCancelActivity?: (id: string) => Promise<{ success: boolean }>`, `onMcpActivity?: (callback: (item: McpActivityItem) => void) => () => void`.

- [ ] **Step 6: 렌더러 순수 함수** — 테스트 먼저 (`src/renderer/lib/mcpActivity.test.ts`)

```ts
import { describe, it, expect } from 'vitest'
import type { McpActivityItem } from '../types'
import { ACTIVITY_STATE_LABELS, MAX_ACTIVITY, countActive, formatElapsed, isActiveState, upsertActivity } from './mcpActivity'

const item = (id: string, startedAt: number, state: McpActivityItem['state'] = 'running'): McpActivityItem => ({
  id, time: 't', sessionId: 's', sessionName: 'dev', command: 'ls', level: 'low', reasons: [], state, startedAt, finishedAt: null
})

describe('mcpActivity', () => {
  it('labels every state', () => {
    expect(Object.keys(ACTIVITY_STATE_LABELS).sort()).toEqual(['blocked', 'cancelled', 'denied', 'done', 'expired', 'failed', 'running', 'timeout', 'waiting'])
  })

  it('treats waiting and running as active', () => {
    expect(isActiveState('waiting')).toBe(true)
    expect(isActiveState('running')).toBe(true)
    expect(isActiveState('done')).toBe(false)
  })

  it('inserts newest first and replaces by id', () => {
    const list = upsertActivity(upsertActivity([], item('a', 1)), item('b', 2))
    expect(list.map(entry => entry.id)).toEqual(['b', 'a'])
    const updated = upsertActivity(list, { ...item('a', 1), state: 'done' })
    expect(updated.map(entry => entry.id)).toEqual(['b', 'a'])
    expect(updated[1].state).toBe('done')
  })

  it('keeps at most the limit', () => {
    let list: McpActivityItem[] = []
    for (let i = 0; i < MAX_ACTIVITY + 5; i++) list = upsertActivity(list, item(`r${i}`, i))
    expect(list).toHaveLength(MAX_ACTIVITY)
    expect(list[0].id).toBe(`r${MAX_ACTIVITY + 4}`)
  })

  it('counts waiting and running requests', () => {
    expect(countActive([item('a', 1, 'waiting'), item('b', 2), item('c', 3, 'done')])).toEqual({ waiting: 1, running: 1 })
  })

  it('formats elapsed time in Korean', () => {
    expect(formatElapsed(0)).toBe('0초')
    expect(formatElapsed(12_400)).toBe('12초')
    expect(formatElapsed(65_000)).toBe('1분 5초')
  })
})
```

구현 (`src/renderer/lib/mcpActivity.ts`):

```ts
import type { McpActivityItem, McpActivityState } from '../types'

export const MAX_ACTIVITY = 100

export const ACTIVITY_STATE_LABELS: Record<McpActivityState, string> = {
  waiting: '확인 대기',
  running: '실행 중',
  done: '완료',
  timeout: '시간 초과',
  denied: '거부',
  expired: '미응답(만료)',
  cancelled: '취소',
  blocked: '차단',
  failed: '실패'
}

export function isActiveState(state: McpActivityState): boolean {
  return state === 'waiting' || state === 'running'
}

export function upsertActivity(list: McpActivityItem[], next: McpActivityItem, max: number = MAX_ACTIVITY): McpActivityItem[] {
  return [next, ...list.filter(item => item.id !== next.id)]
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, max)
}

export function countActive(list: McpActivityItem[]): { waiting: number; running: number } {
  return {
    waiting: list.filter(item => item.state === 'waiting').length,
    running: list.filter(item => item.state === 'running').length
  }
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(seconds / 60)
  return minutes > 0 ? `${minutes}분 ${seconds % 60}초` : `${seconds}초`
}
```

- [ ] **Step 7: 스토어와 구독 훅**

`src/renderer/stores/mcpActivityStore.ts`:

```ts
import { create } from 'zustand'
import type { McpActivityItem } from '../types'
import { upsertActivity } from '../lib/mcpActivity'

interface McpActivityState {
  items: McpActivityItem[]
  isPanelOpen: boolean
  setAll: (items: McpActivityItem[]) => void
  upsert: (item: McpActivityItem) => void
  setPanelOpen: (open: boolean) => void
}

export const useMcpActivityStore = create<McpActivityState>((set) => ({
  items: [],
  isPanelOpen: false,
  setAll: (items) => set({ items: items.reduce<McpActivityItem[]>((list, item) => upsertActivity(list, item), []) }),
  upsert: (item) => set((state) => ({ items: upsertActivity(state.items, item) })),
  setPanelOpen: (open) => set({ isPanelOpen: open })
}))
```

`src/renderer/hooks/useMcpActivityFeed.ts` — 마운트 때 한 번 `mcpListActivity()` 로 채우고 `onMcpActivity` 를 구독, 언마운트 때 해제. preload 에 API 가 없으면(재시작 전) 아무 일도 하지 않는다 (`typeof` 확인).

```ts
import { useEffect } from 'react'
import { useMcpActivityStore } from '../stores/mcpActivityStore'

/** Keeps the MCP activity store in sync with the main process. Mount once. */
export function useMcpActivityFeed(): void {
  useEffect(() => {
    const api = window.electronAPI
    if (typeof api?.onMcpActivity !== 'function' || typeof api?.mcpListActivity !== 'function') return
    const { setAll, upsert } = useMcpActivityStore.getState()
    let isMounted = true
    api.mcpListActivity()
      .then((result) => { if (isMounted && result.success) setAll(result.items) })
      .catch(() => { /* the live feed below still works */ })
    const off = api.onMcpActivity((item) => upsert(item))
    return () => {
      isMounted = false
      off()
    }
  }, [])
}
```

- [ ] **Step 8: 상태 표시줄 표시와 활동 패널**

`McpActivityIndicator.tsx` (Footer 의 `footer-right` 맨 앞에 렌더링):
- `useMcpActivityFeed()` 를 여기서 호출한다 (Footer 는 잠금 해제 동안 항상 있음, App.tsx 는 건드리지 않는다).
- 항목이 하나도 없으면 아무것도 그리지 않는다.
- 진행 중인 요청이 있으면 `MCP · 확인 대기 N · 실행 중 M` (0 인 부분은 생략) 과 깜빡이는 점, 없으면 `MCP 활동`.
- 버튼이며 클릭하면 패널을 연다/닫는다. `aria-expanded`, `aria-controls="mcp-activity-panel"`.
- `<McpActivityPanel />` 도 여기서 렌더링한다 (열렸을 때만).

`McpActivityPanel.tsx`:
- 오른쪽에 고정된 패널 (`role="complementary"`, `aria-label="MCP 활동"`, `id="mcp-activity-panel"`), 너비 `min(440px, 100vw - 32px)`, 위는 제목 표시줄 아래부터 아래는 상태 표시줄 위까지.
- 머리말: 제목 `MCP 활동`, 설명 `출력은 앱이 켜져 있는 동안만 보관합니다.`, 닫기 버튼 (Esc 로도 닫힘).
- 목록: 최신순. 한 줄에 시각(`HH:MM:SS`), 세션 이름, 명령(고정폭 한 줄 말줄임, `title` 에 전체), 위험도 배지(`RISK_LABELS`, `mcp-risk-*` 클래스 재사용), 상태 배지(`ACTIVITY_STATE_LABELS`), 진행 중이면 경과 시간(1초마다 갱신, `formatElapsed(now - startedAt)`), 끝났으면 종료 코드.
- 진행 중(`waiting`/`running`)인 줄에는 `중지` 버튼 → `mcpCancelActivity(id)`; 실패 응답이면 오류 토스트.
- 줄을 누르면 펼쳐져 판단 근거 목록과 `output` 을 `<pre>` 로 보여 준다 (`output` 이 없으면 `아직 출력이 없습니다.`).
- 항목이 없으면 `아직 MCP 요청이 없습니다.`
- 스타일은 `McpActivity.css` 에 두고 `variables.css` 토큰만 쓴다 (모서리 없음 `--radius-*`). 상태 배지 색: 진행 중 `--accent`, 완료 `--success`, 시간 초과·만료 `--warning`, 거부·취소·차단·실패 `--error`.

- [ ] **Step 9: 검증**

Run: `npm run typecheck && npx vitest run && npm run build`
Expected: 모두 통과.

임시 인스턴스(Task 11 Step 8 방법)에서 MCP 서버를 켜고, Task 14 Step 3 의 curl 로 `ls` 와 `rm nothing.txt` 를 보낸다:
- 상태 표시줄에 `MCP · 실행 중 1` → 끝나면 `MCP 활동` 으로 바뀌는지
- 패널에 두 요청이 최신순으로 있고, `rm` 은 `확인 대기` → (거부) `거부` 로 바뀌는지
- `확인 대기` 중에 패널의 `중지` 를 누르면 확인 창이 닫히고 상태가 `취소` 가 되는지
- 줄을 펼치면 출력이 보이는지
- 앱을 새로 고쳐도(`Ctrl+R`) 목록이 다시 채워지는지 (main 이 메모리에 갖고 있으므로)

- [ ] **Step 10: 체크박스 갱신**

---

## 범위 밖으로 확인된 기존 문제

- `main.js` 의 `save-sessions` 는 `password`, `passphrase`, `privateKeyPath` 만 암호화하고 **Jump Host 의 `jumpPassword`, `jumpPassphrase`, `jumpPrivateKeyPath` 는 `sessions.json` 에 평문으로 저장**한다. 이번 작업과 별개로 고쳐야 한다 (사용자에게 보고).
