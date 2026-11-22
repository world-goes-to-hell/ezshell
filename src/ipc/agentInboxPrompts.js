// These messages are pasted into the agent's composer, so they can also appear in a transcript.
const PROMPT = 'New ezShell message: read it with read_inbox, then handle it.'
const BUSY_PROMPT = 'New ezShell message while you are busy: read it now with read_inbox; handle it after your current task.'
const REMIND_PROMPT = 'Your task is done: handle the ezShell request you put off, then send the result with reply_to_message.'

const inboxPrompts = new Set([
  PROMPT, BUSY_PROMPT, REMIND_PROMPT,
  'New ezShell message: read it with read_inbox, confirm it now with send_receipt, then handle it.',
  'New ezShell message while you are busy: read it with read_inbox and confirm it now with send_receipt, saying what you will finish first; handle it after your current task.'
])

const isInboxPrompt = text => inboxPrompts.has(text.trim())

module.exports = { PROMPT, BUSY_PROMPT, REMIND_PROMPT, isInboxPrompt }
