import { describe, expect, it } from 'vitest'
import { Text } from '@codemirror/state'
import { scanProblems } from '../renderer/lib/logProblems'
import { createDevelopmentErrors } from './developmentErrors.js'

describe('development task output', () => {
  it.each([
    ['2026-11-25 10:00:01 INFO Tomcat started on port 8080 (http) with context path \'/\'', 'http://localhost:8080'],
    ['2026-11-25 10:00:02 INFO Started DemoApplication in 2.437 seconds (process running for 2.903)', undefined],
    ['  VITE v5.4.0  ready in 215 ms\n  ➜  Local:   http://localhost:5173/', 'http://localhost:5173'],
    ['  App running at:\n  - Local:   http://localhost:8081/', 'http://localhost:8081']
  ])('recognizes startup from %s', (output, address) => {
    const log = createDevelopmentErrors(() => 12)
    log.feed(output + '\n')
    expect(log.state()).toEqual({ readyAt: 12, address, errors: 0 })
  })

  it.each([
    '***************************\nAPPLICATION FAILED TO START\n***************************',
    'Web server failed to start. Port 8080 was already in use.',
    '11:17:03 [vite] Internal server error: Failed to resolve import "vue"',
    ' ERROR  Failed to compile with 1 error',
    'FAILURE: Build failed with an exception.',
    '[INFO] BUILD FAILURE',
    '[ERROR] Failed to execute goal org.springframework.boot:spring-boot-maven-plugin:run'
  ])('keeps a stack under %s', output => {
    const log = createDevelopmentErrors(() => 34)
    log.feed(`${output}\n`)
    // Spring's decoration rows can separate a report from the following message.
    expect(log.groups()).toHaveLength(1)
    expect(log.groups()[0]).toMatchObject({ at: 34 })
  })

  it('shares general grouping rules with the log view across split CRLF and escape sequences', () => {
    const rows = ['INFO started', 'ERROR error decoding record', '    at parse (/app/a.js:3:9)',
      'WARN request took a while', '    at warn (/app/b.js:4:9)', 'DEBUG retrying',
      'Traceback (most recent call last):', '  File "app.py", line 9, in work', '    do_work()', 'ValueError: bad value']
    const doc = Text.of(rows)
    const log = createDevelopmentErrors()
    for (const [i, row] of rows.entries()) log.feed(`${i ? '\n' : ''}\x1b[31m${row}\x1b[0m\r`)
    log.feed('\n\x1b]0;terminal title\x07INFO\x00 complete')
    log.finish()
    expect(log.groups().map(group => group.lines[0])).toEqual(scanProblems(doc).filter(p => p.level === 'error').map(p => doc.lineAt(p.pos).text))
    expect(log.groups().at(-1).lines).toEqual(rows.slice(-4))
    expect(log.lines()).toEqual([...rows, 'INFO complete'])
  })

  it('caps output and grouped errors independently', () => {
    const log = createDevelopmentErrors()
    for (let i = 0; i < 21; i++) log.feed(`ERROR failure ${i}\n${'    at parse (/app/a.js:3:9)\n'.repeat(85)}`)
    expect(log.lines()).toHaveLength(400)
    expect(log.groups()).toHaveLength(20)
    expect(log.groups()[0].lines).toHaveLength(80)
    expect(log.groups()[0].lines[0]).toBe('ERROR failure 1')
  })

  it('removes bidirectional and other formatting controls from output and errors', () => {
    const log = createDevelopmentErrors()
    log.feed('ER\u202eROR fail\u2066ed\u2069\u200b\n')
    expect(log.lines()).toEqual(['ERROR failed'])
    expect(log.groups()[0].lines).toEqual(['ERROR failed'])
  })
})
