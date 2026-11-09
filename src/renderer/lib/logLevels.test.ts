import { describe, it, expect } from 'vitest'
import { classifyLine, markerLine } from './logLevels'

describe('log line levels', () => {
  it.each([
    ['2026-11-05 10:00:01 ERROR [main] db down', 'error'],
    ['2026-11-05 10:00:01.123 FATAL boot failed', 'error'],
    ['Nov  5 10:00:01 host kernel: CRITICAL temperature', 'error'],
    ['SEVERE: Servlet.service() threw exception', 'error'],
    ['[Wed Nov 05 10:00:01 2026] [error] [client 1.2.3.4] File does not exist', 'error'],
    ['2026/11/05 10:00:01 [crit] 123#0: *1 open() failed', 'error'],
    ['time="2026-11-05" level=error msg="boom"', 'error'],
    ['{"time":"x","level":"fatal","msg":"boom"}', 'error'],
    ['java.lang.NullPointerException: name is null', 'error'],
    ['TypeError: Cannot read properties of undefined', 'error'],
    ['Traceback (most recent call last):', 'error'],
    ['  File "app.py", line 3, in <module>', 'error'],
    ['\tat com.example.App.run(App.java:42)', 'error'],
    ['    at Object.<anonymous> (/srv/app.js:10:5)', 'error'],
    ['\t... 12 more', 'error'],
    ['Caused by: java.io.IOException: closed', 'error'],
    ['panic: runtime error: index out of range', 'error'],
    ['2026-11-05 WARN disk 91%', 'warn'],
    ['WARNING: deprecated option', 'warn'],
    ['2026/11/05 10:00:01 [warn] 123#0: upstream slow', 'warn'],
    ['level=warning msg=slow', 'warn'],
    ['2026-11-05 DEBUG cache hit', 'debug'],
    ['TRACE entering handler', 'debug']
  ])('%s → %s', (line, level) => {
    expect(classifyLine(line)).toBe(level)
  })

  it.each([
    'INFO 0 errors, 2 warnings',
    'request handled, no error',
    'INFO retried after IOException: timeout',
    'INFO lastError: none',
    'ERR_CONNECTION_REFUSED is a browser code',
    'plain text line',
    ''
  ])('%s → nothing', (line) => {
    expect(classifyLine(line)).toBeNull()
  })

  it('takes the first level word of the line', () => {
    expect(classifyLine('2026-11-05 INFO sent ERROR report to admin')).toBeNull()
    expect(classifyLine('2026-11-05 WARN retry 3 of 3 before ERROR')).toBe('warn')
  })

  it('tells the window marker lines from log lines', () => {
    expect(classifyLine(markerLine('파일이 새로 시작됨'))).toBe('marker')
    expect(markerLine('3MB 건너뜀')).toContain('3MB 건너뜀')
  })
})
