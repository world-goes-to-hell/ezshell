const MASK = '****'
const URL_CREDENTIALS = /(\b[a-z][\w+.-]*:\/\/)[^@/\s"'<>]+:[^@/\s"'<>]*@/gi
const AUTHORIZATION = /(\b(?:proxy-)?authorization["']?[ \t]*[:=][ \t]*["']?(?:(?:bearer|basic)[ \t]+)?|\bbearer[ \t]+)[^\s,"'<>;]+/gi
const ASSIGNMENT = /((?<![\w.-])[\w.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)[\w.-]*["']?[ \t]*[:=][ \t]*)("(?:\\[^\r\n]|[^"\\\r\n])*(?:"|(?=\r?$))|'(?:\\[^\r\n]|[^'\\\r\n])*(?:'|(?=\r?$))|[^\s,;"'<>}\]]+)/gim
const XML_CREDENTIALS = /(<(?:[\w.-]+:)?(?:password|passwd|pwd|secret|token)\b[^<>]*>)[^<\r\n]+/gi
const TOKEN = /\b(?:(?:AKIA|ASIA)[A-Z0-9]{16}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g

function redactRunSecrets(text) {
  return text
    .replace(URL_CREDENTIALS, `$1${MASK}@`)
    .replace(AUTHORIZATION, `$1${MASK}`)
    .replace(ASSIGNMENT, (_match, key, value) => {
      const quote = value[0]
      return quote === '"' || quote === "'" ? `${key}${quote}${MASK}${quote}` : key + MASK
    })
    .replace(XML_CREDENTIALS, `$1${MASK}`)
    .replace(TOKEN, MASK)
}

function redactRunOutput(value) {
  if (typeof value === 'string') return redactRunSecrets(value)
  if (Array.isArray(value)) return value.map(redactRunOutput)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactRunOutput(entry)]))
  }
  return value
}

module.exports = { redactRunSecrets, redactRunOutput }
