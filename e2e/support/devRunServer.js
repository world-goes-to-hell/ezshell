// Deterministic stand-in for a frontend dev server in the execution-card specification.
const http = require('node:http')

const crashFlag = process.argv.indexOf('--crash-after')
const crashAfter = crashFlag === -1 ? null : Number(process.argv[crashFlag + 1])
const server = http.createServer((_request, response) => response.end('ready'))

server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`VITE v5.4.0 ready in 25 ms\n  ➜  Local: http://localhost:${server.address().port}/\n`)
  if (crashAfter !== null) setTimeout(() => {
    process.stderr.write('\x1b[31m[vite] Internal server error: fixture failed pwd=fixture-terminal-only\x1b[0m\n    at fixture (/src/main.js:12:3)\n', () => process.exit(1))
  }, crashAfter)
})
