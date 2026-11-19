// The fake agents of localAgentApp.js, with the agents' transcript folders inside the test profile (the
// chat view reads `$CLAUDE_CONFIG_DIR/projects`, never this PC's own ~/.claude) and chat lines recorded.
const { app } = require('electron')
const fs = require('fs')
const path = require('path')

const profile = app.commandLine.getSwitchValue('user-data-dir')
process.env.CLAUDE_CONFIG_DIR = path.join(profile, 'claude-home')
process.env.CODEX_HOME = path.join(profile, 'codex-home')
fs.mkdirSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'test'), { recursive: true })
fs.mkdirSync(path.join(process.env.CODEX_HOME, 'sessions'), { recursive: true })
process.env.EZSHELL_TEST_AGENT_CHAT = '1'
require('./localAgentApp.js')
