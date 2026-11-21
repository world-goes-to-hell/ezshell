// The fake agents of agentChatApp.js, with a minute of idle time lasting one second: an idle agent gives
// back memory and sleeps within seconds (src/agentIdle.js, e2e/specs/local-agent-sleep.js)
process.env.EZSHELL_TEST_IDLE_MINUTE_MS = '1000'
require('./agentChatApp.js')
