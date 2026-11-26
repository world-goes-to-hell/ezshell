const { stripVTControlCharacters } = require('node:util')
const { classifyProblemLine } = require('./logLevels.mjs')
const { developmentAddress } = require('./developmentProcess.js')

const MAX_LOG_LINES = 400
const MAX_GROUPS = 20
const MAX_GROUP_LINES = 80
const MAX_LINE_CHARS = 2048
const READY = /\bStarted .+ in [\d.]+ seconds?\b|\bLocal:\s+https?:\/\/|\bServer startup in\b|\bready in\s+[\d.]+\s*ms\b/i
const TOMCAT_START = /\borg\.apache\.catalina\.startup\.Catalina\.start(?:\s|$)/
const TOMCAT_START_HEADER = /\borg\.apache\.catalina\.startup\.Catalina\s+start\s*$/
const TOMCAT_INFO = /(?:^|\s)(?:INFO|정보)\s+\[/
const KNOWN_ERROR = /\bAPPLICATION FAILED TO START\b|\bPort \d+ was already in use\b|\bEADDRINUSE\b|\bFailed to compile\b|\[vite\]\s+Internal server error\b|\berror TS\d+\b|\bBUILD FAILURE\b|\bFAILURE:\s+Build failed\b|\bError deploying (?:web application|configuration descriptor)\b/
const TERMINAL_STRING = /(?:\x1b[\]PX^_]|[\x90\x98\x9d-\x9f])[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c|$)/g

function cleanLogLine(text) {
  return stripVTControlCharacters(text.replace(TERMINAL_STRING, '')).replace(/[\x00-\x08\x0a-\x1f\x7f-\x9f\p{Cf}]/gu, '').slice(0, MAX_LINE_CHARS)
}

function createDevelopmentErrors(now = Date.now, { tomcat = false } = {}) {
  const lines = []
  const groups = []
  let fragment = ''
  let endedWithCR = false
  let previous = ''
  let inside = false
  let group = null
  let address
  let readyAt
  let tomcatStartHeader = false

  function pushLine(line) {
    if (lines.length === MAX_LOG_LINES) lines.shift()
    lines.push(line)
  }

  function pushGroup(report) {
    if (groups.length === MAX_GROUPS) groups.shift()
    groups.push(report)
  }

  function consume(raw, readiness) {
    const line = cleanLogLine(raw)
    pushLine(line)
    if (readiness) {
      if (tomcat) {
        if ((TOMCAT_START.test(line) && TOMCAT_INFO.test(line)) ||
          (tomcatStartHeader && /^(?:INFO|정보):/.test(line)) || /\bServer startup in\b/.test(line)) readyAt ??= now()
        tomcatStartHeader = TOMCAT_START_HEADER.test(line)
      } else {
        address ??= developmentAddress([line]) ?? undefined
        if (address || READY.test(line)) readyAt ??= now()
      }
    }
    const next = classifyProblemLine(line, previous, inside)
    const known = KNOWN_ERROR.test(line)
    if (known || (next.start && next.level === 'error')) {
      group = { at: now(), lines: [line] }
      pushGroup(group)
    } else if (!next.inside || (next.start && next.level === 'warn')) {
      group = null
    } else if (group && group.lines.length < MAX_GROUP_LINES) {
      group.lines.push(line)
    }
    inside = known || next.inside
    previous = line
  }

  function feed(chunk, readiness = true) {
    if (!chunk.length) return
    const rows = (fragment + (endedWithCR && chunk.startsWith('\n') ? chunk.slice(1) : chunk)).split(/\r\n|\n|\r/)
    endedWithCR = chunk.endsWith('\r')
    fragment = rows.pop().slice(0, MAX_LINE_CHARS)
    for (const row of rows) consume(row, readiness)
  }

  return {
    feed,
    addError(title, details = []) {
      const report = [title, ...details].slice(0, MAX_GROUP_LINES).map(cleanLogLine)
      pushGroup({ at: now(), lines: report })
      for (const line of report) pushLine(line)
    },
    finish(readiness = true) {
      if (fragment) consume(fragment, readiness)
      fragment = ''
      endedWithCR = false
    },
    state: () => ({ address, readyAt, errors: groups.length }),
    groups: () => groups.map(item => ({ ...item, lines: [...item.lines] })),
    lines: (count = MAX_LOG_LINES) => lines.slice(-count)
  }
}

module.exports = { createDevelopmentErrors, cleanLogLine, MAX_LOG_LINES }
