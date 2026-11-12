import { describe, it, expect } from 'vitest'
import { StringStream } from '@codemirror/language'
import { configParser, fallbackLanguage, namesWithoutBackupMarks } from './configLanguage'

/** The coloured parts of one line, as [text, style] pairs (plain text and spaces left out) */
function parts(line: string): Array<[string, string]> {
  const state = configParser.startState!(2)
  const stream = new StringStream(line, 4, 2)
  const out: Array<[string, string]> = []
  while (!stream.eol()) {
    stream.start = stream.pos
    const style = configParser.token(stream, state)
    if (style) out.push([stream.current(), style])
    if (stream.pos === stream.start) throw new Error(`no progress at ${stream.pos} in ${line}`)
  }
  return out
}

describe('configParser', () => {
  it('shows a commented-out line as a comment', () => {
    expect(parts('# DB_URL=jdbc:postgresql://db:5432/app')).toEqual([['# DB_URL=jdbc:postgresql://db:5432/app', 'comment']])
    expect(parts('  ; old value')).toEqual([['; old value', 'comment']])
    expect(parts('// note')).toEqual([['// note', 'comment']])
  })

  it('makes the key of a setting stand out', () => {
    expect(parts('PORTAL_PORT=18081')).toEqual([['PORTAL_PORT', 'propertyName'], ['=', 'operator'], ['18081', 'number']])
    expect(parts('DB_PASSWORD=\'mbris_2023\'')).toEqual([['DB_PASSWORD', 'propertyName'], ['=', 'operator'], ['\'mbris_2023\'', 'string']])
    expect(parts('export JAVA_HOME=/usr/lib/jvm')).toEqual([['export', 'keyword'], ['JAVA_HOME', 'propertyName'], ['=', 'operator']])
    expect(parts('server.port: 8080')).toEqual([['server.port', 'propertyName'], [':', 'operator'], ['8080', 'number']])
  })

  it('colours values: true/false, variables, a comment after a value', () => {
    expect(parts('BATCH_SWAP_ENABLED=true')).toEqual([['BATCH_SWAP_ENABLED', 'propertyName'], ['=', 'operator'], ['true', 'atom']])
    expect(parts('PATH=$JAVA_HOME/bin:${PATH}')).toEqual([['PATH', 'propertyName'], ['=', 'operator'], ['$JAVA_HOME', 'typeName'], ['${PATH}', 'typeName']])
    expect(parts('TIMEOUT=30 # seconds')).toEqual([['TIMEOUT', 'propertyName'], ['=', 'operator'], ['30', 'number'], ['# seconds', 'comment']])
  })

  it('leaves a # inside a value alone, and a URL as plain text', () => {
    expect(parts('COLOR=#ff0000')).toEqual([['COLOR', 'propertyName'], ['=', 'operator']])
    expect(parts('DB_URL=jdbc:postgresql://db:5432/app?x=1')).toEqual([['DB_URL', 'propertyName'], ['=', 'operator']])
    expect(parts('HOST=10.0.0.12')).toEqual([['HOST', 'propertyName'], ['=', 'operator']])
  })

  it('handles sections and directives without a sign', () => {
    expect(parts('[Service]')).toEqual([['[Service]', 'heading']])
    expect(parts('Port 22')).toEqual([['Port', 'propertyName'], ['22', 'number']])
    expect(parts('  server_name example.com;')).toEqual([['server_name', 'propertyName']])
    expect(parts('PermitRootLogin no')).toEqual([['PermitRootLogin', 'propertyName'], ['no', 'atom']])
  })

  it('gets through an unclosed quote and odd characters', () => {
    expect(parts('NAME="unclosed')).toEqual([['NAME', 'propertyName'], ['=', 'operator'], ['"unclosed', 'string']])
    expect(parts('$ = "')).toEqual([['"', 'string']])
  })
})

describe('fallbackLanguage', () => {
  it('knows configuration and shell start-up files', () => {
    for (const name of ['.env', '.env.local', 'env', 'portal.env', 'app.conf', 'my.cnf', 'nginx.service', 'hosts', 'sshd_config', 'crontab']) expect(fallbackLanguage(name), name).toBe('config')
    for (const name of ['.bashrc', '.profile', '.zshrc']) expect(fallbackLanguage(name), name).toBe('shell')
  })

  it('leaves other files alone', () => {
    for (const name of ['README', 'notes.txt', 'data.bin', 'environment.ts']) expect(fallbackLanguage(name), name).toBeNull()
  })
})

describe('namesWithoutBackupMarks', () => {
  it('strips the marks people add to a backup, one by one', () => {
    expect(namesWithoutBackupMarks('compose.yaml.bak_20261020_1516')).toEqual(['compose.yaml.bak_20261020_1516', 'compose.yaml.bak_20261020', 'compose.yaml.bak', 'compose.yaml'])
    expect(namesWithoutBackupMarks('index.jsp.261102')).toEqual(['index.jsp.261102', 'index.jsp'])
    expect(namesWithoutBackupMarks('portal.env~')).toEqual(['portal.env~', 'portal.env'])
  })

  it('keeps a name that has no mark', () => {
    expect(namesWithoutBackupMarks('compose.yaml')).toEqual(['compose.yaml'])
    expect(namesWithoutBackupMarks('my-app.conf')).toEqual(['my-app.conf'])
  })
})
