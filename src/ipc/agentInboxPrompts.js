// These messages are pasted into the agent's composer, so they can also appear in a transcript.
const PROMPT = 'New ezShell message: read it with read_inbox, then handle it.'
const BUSY_PROMPT = 'New ezShell message while you are busy: read it now with read_inbox; handle it after your current task.'
const REMIND_PROMPT = 'Your task is done: handle the ezShell request you put off, then send the result with reply_to_message.'

const inboxPrompts = new Set([
  PROMPT, BUSY_PROMPT, REMIND_PROMPT,
  'New ezShell message: read it with read_inbox, confirm it now with send_receipt, then handle it.',
  'New ezShell message while you are busy: read it with read_inbox and confirm it now with send_receipt, saying what you will finish first; handle it after your current task.'
])

// The user's "지금 알리기" on one message (the chat's bell, agent-inbox-notify): names the message so the agent
// handles that one now, even while busy. Built only by main from a message id it checked.
const MESSAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const messagePrompt = id => {
  if (!MESSAGE_ID.test(id)) throw new Error('메시지를 확인해 주세요.')
  return `ezShell message ${id} is waiting for you: read it now with read_inbox, then handle it.`
}
const MESSAGE_PROMPT = /^ezShell message [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12} is waiting for you: read it now with read_inbox, then handle it\.$/i

// An agent's send_message with urgent: true (2026-11-28 user request): goes in through the same chat send path
// while the recipient works, so it reads the message before finishing its current task. Built only by main.
const urgentPrompt = id => {
  if (!MESSAGE_ID.test(id)) throw new Error('메시지를 확인해 주세요.')
  return `Urgent ezShell message ${id}: pause your current task, read it now with read_inbox and handle it first.`
}
const URGENT_PROMPT = /^Urgent ezShell message [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}: pause your current task, read it now with read_inbox and handle it first\.$/i

const isInboxPrompt = text => inboxPrompts.has(text.trim()) || MESSAGE_PROMPT.test(text.trim()) || URGENT_PROMPT.test(text.trim())

module.exports = { PROMPT, BUSY_PROMPT, REMIND_PROMPT, isInboxPrompt, messagePrompt, urgentPrompt, MESSAGE_ID }
