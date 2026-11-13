import { describe, it, expect } from 'vitest'
import { fileZone, visiblePart, isRelativeName, zoneHasOutput, listingBase, isListing, zoneBlocks, lookupName } from './terminalFileZone'

describe('fileZone', () => {
  it('runs from the line where the folder last changed to the line above the cursor', () => {
    expect(fileZone({ start: 40, cursorRow: 46, isAlternate: false })).toEqual({ start: 40, end: 45 })
  })

  it('is empty right after the folder changed (nothing printed yet)', () => {
    expect(fileZone({ start: 46, cursorRow: 46, isAlternate: false })).toBeNull()
  })

  it('does not exist without a known folder or in a full-screen program', () => {
    expect(fileZone({ start: null, cursorRow: 46, isAlternate: false })).toBeNull()
    expect(fileZone({ start: 40, cursorRow: 46, isAlternate: true })).toBeNull()
  })
})

describe('visiblePart', () => {
  const zone = { start: 40, end: 45 }

  it('is the whole zone when it is on screen', () => {
    expect(visiblePart(zone, 30, 24)).toEqual({ top: 40, height: 6, cutTop: false, cutBottom: false })
  })

  it('starts at the top row when the zone began above the screen', () => {
    expect(visiblePart(zone, 43, 24)).toEqual({ top: 43, height: 3, cutTop: true, cutBottom: false })
  })

  it('ends at the bottom row when the zone goes below the screen (scrolled up)', () => {
    expect(visiblePart(zone, 30, 12)).toEqual({ top: 40, height: 2, cutTop: false, cutBottom: true })
  })

  it('is nothing when the zone is entirely off screen', () => {
    expect(visiblePart(zone, 0, 24)).toBeNull()
    expect(visiblePart(zone, 50, 24)).toBeNull()
  })
})

describe('isRelativeName', () => {
  it('tells relative names from absolute and home paths', () => {
    expect(isRelativeName('catalina.log')).toBe(true)
    expect(isRelativeName('logs/app.log')).toBe(true)
    expect(isRelativeName('/data/app.log')).toBe(false)
    expect(isRelativeName('~/app.log')).toBe(false)
  })
})

describe('zoneHasOutput', () => {
  it('needs at least one line that is not a prompt', () => {
    expect(zoneHasOutput(['[root@devel-docker-1 logs]# ll', '합계 196', '-rw-r----- 1 10001 10001 302 11월 13 10:36 localhost.log'])).toBe(true)
  })

  it('is false for a zone of prompts only (cd, or Enter on an empty prompt)', () => {
    expect(zoneHasOutput(['[root@devel-docker-1 wscope-dev]# cd ..'])).toBe(false)
    expect(zoneHasOutput(['user@host:/data$ ', 'user@host:/data$ ', ''])).toBe(false)
  })

  it('ignores empty lines', () => {
    expect(zoneHasOutput(['', '   '])).toBe(false)
  })
})

describe('listingBase', () => {
  it('lists the current folder for plain ls / ll and other commands', () => {
    expect(listingBase('ll')).toEqual({ kind: 'cwd' })
    expect(listingBase('ls -la')).toEqual({ kind: 'cwd' })
    expect(listingBase('ls .')).toEqual({ kind: 'cwd' })
    expect(listingBase('cat compose.yaml')).toEqual({ kind: 'cwd' })
    expect(listingBase('grep -rn error logs')).toEqual({ kind: 'cwd' })
    expect(listingBase(null)).toEqual({ kind: 'cwd' })
  })

  it('lists another folder when ls gets one folder', () => {
    expect(listingBase('ls ../')).toEqual({ kind: 'dir', dir: '..' })
    expect(listingBase('ll /var/log')).toEqual({ kind: 'dir', dir: '/var/log' })
    expect(listingBase('ls -lh "my logs/"')).toEqual({ kind: 'dir', dir: 'my logs' })
    expect(listingBase('\\ls ~/apps | grep x')).toEqual({ kind: 'dir', dir: '~/apps' })
    expect(listingBase('sudo ls -l /root')).toEqual({ kind: 'dir', dir: '/root' })
  })

  it('looks past assignments, env and sudo options to the command', () => {
    expect(listingBase('LANG=C ls /var/log')).toEqual({ kind: 'dir', dir: '/var/log' })
    expect(listingBase('sudo -u app ls /srv/app')).toEqual({ kind: 'dir', dir: '/srv/app' })
    expect(listingBase('sudo -E LC_ALL=C ls -l /root')).toEqual({ kind: 'dir', dir: '/root' })
    expect(listingBase('env TZ=UTC ls ..')).toEqual({ kind: 'dir', dir: '..' })
  })

  it('cannot tell when a prefix option may change the folder or the shell', () => {
    expect(listingBase('sudo -i ls')).toEqual({ kind: 'none' })
    expect(listingBase('sudo -D /tmp ls')).toEqual({ kind: 'none' })
    expect(listingBase('nice -n 5 ls /x')).toEqual({ kind: 'none' })
  })

  it('cannot tell for globs that may expand to folders', () => {
    expect(listingBase('ls *')).toEqual({ kind: 'none' })
    expect(listingBase('ls */')).toEqual({ kind: 'none' })
    expect(listingBase('ls logs/*')).toEqual({ kind: 'none' })
  })

  it('keeps the current folder for globs and ls -d (names come out as given)', () => {
    expect(listingBase('ls *.log')).toEqual({ kind: 'cwd' })
    expect(listingBase('ls -ld logs')).toEqual({ kind: 'cwd' })
  })

  it('cannot tell for several folders, recursive listings, tree and chained commands', () => {
    expect(listingBase('ls logs was')).toEqual({ kind: 'none' })
    expect(listingBase('ls -R')).toEqual({ kind: 'none' })
    expect(listingBase('ls --recursive logs')).toEqual({ kind: 'none' })
    expect(listingBase('tree')).toEqual({ kind: 'none' })
    expect(listingBase('cd logs && ls')).toEqual({ kind: 'none' })
    expect(listingBase('ls; ls ..')).toEqual({ kind: 'none' })
  })
})

describe('isListing', () => {
  it('is true for commands that print a file list', () => {
    for (const command of ['ll', 'ls -la', 'ls ../', 'LANG=C ls /var/log', 'sudo -u app ls /srv', 'ls -l | grep .log', 'la']) {
      expect(isListing(command)).toBe(true)
    }
  })

  it('is false for other commands, even when their output has names', () => {
    for (const command of ['docker ps | grep ora', 'cat compose.yaml', 'grep -rn error logs', 'tail -f app.log', 'find . -name x', 'tree', 'ls; pwd', '', null]) {
      expect(isListing(command)).toBe(false)
    }
  })
})

describe('zoneBlocks and lookupName', () => {
  const zone = { start: 10, end: 30 }
  const commands = [
    { row: 10, base: { kind: 'cwd' as const }, listing: true },
    { row: 15, base: { kind: 'dir' as const, dir: '..' }, listing: true },
    { row: 22, base: { kind: 'none' as const }, listing: false }
  ]

  it('cuts the zone at each command line', () => {
    expect(zoneBlocks(zone, commands)).toEqual([
      { start: 10, end: 14, base: { kind: 'cwd' }, listing: true },
      { start: 15, end: 21, base: { kind: 'dir', dir: '..' }, listing: true },
      { start: 22, end: 30, base: { kind: 'none' }, listing: false }
    ])
  })

  it('treats rows before the first command (or without commands) as the current folder', () => {
    expect(zoneBlocks(zone, [{ row: 12, base: { kind: 'none' } }])).toEqual([
      { start: 10, end: 11, base: { kind: 'cwd' }, listing: false },
      { start: 12, end: 30, base: { kind: 'none' }, listing: false }
    ])
    expect(zoneBlocks(zone, [])).toEqual([{ start: 10, end: 30, base: { kind: 'cwd' }, listing: false }])
    expect(zoneBlocks(zone, [{ row: 5, base: { kind: 'none' } }])).toEqual([{ start: 10, end: 30, base: { kind: 'cwd' }, listing: false }])
  })

  it('looks a name up in the folder its command listed', () => {
    expect(lookupName('compose.yaml', 12, zone, commands)).toBe('compose.yaml')
    expect(lookupName('test.txt', 18, zone, commands)).toBe('../test.txt')
    expect(lookupName('anything', 25, zone, commands)).toBeNull()
  })

  it('reads names on a command line itself in the current folder', () => {
    expect(lookupName('notes.txt', 15, zone, commands)).toBe('notes.txt')
    expect(lookupName('notes.txt', 22, zone, commands)).toBe('notes.txt')
  })

  it('takes absolute and home paths anywhere and nothing relative outside the zone', () => {
    expect(lookupName('/etc/hosts', 25, zone, commands)).toBe('/etc/hosts')
    expect(lookupName('~/a.log', 3, zone, commands)).toBe('~/a.log')
    expect(lookupName('a.log', 3, zone, commands)).toBeNull()
    expect(lookupName('a.log', 3, null, commands)).toBeNull()
  })

  it('joins names under an absolute or home folder', () => {
    const others = [{ row: 10, base: { kind: 'dir' as const, dir: '/var/log/' } }]
    expect(lookupName('syslog', 12, zone, others)).toBe('/var/log/syslog')
  })
})
