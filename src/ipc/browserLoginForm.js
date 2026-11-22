/** Runs only in ezShell's isolated world in the main frame. Returns a status, never field values. */
function fillLoginForm(origin, username, password) {
  if (location.origin !== origin) return 'changed'

  const isVisibleInput = input => input instanceof HTMLInputElement && !input.matches(':disabled') &&
    !input.readOnly && input.checkVisibility({ visibilityProperty: true, opacityProperty: true })
  const hasToken = (input, token) => input.autocomplete.toLowerCase().split(/\s+/).includes(token)
  const fields = Array.from(document.querySelectorAll('input')).filter(isVisibleInput)
  const passwordFields = fields.filter(input => input.type === 'password' && !hasToken(input, 'new-password') && !hasToken(input, 'one-time-code'))
  const current = passwordFields.filter(input => hasToken(input, 'current-password'))
  const candidates = current.length ? current : passwordFields
  if (candidates.length !== 1) return 'no-form'
  const passwordField = candidates[0]
  const { form } = passwordField
  if (form && new URL(form.getAttribute('action') || document.URL, document.baseURI).origin !== origin) return 'no-form'

  const possibleUsers = fields.filter(input => input.form === form && ['text', 'email', 'tel'].includes(input.type) &&
    !hasToken(input, 'new-password') && !hasToken(input, 'one-time-code'))
  const usernames = possibleUsers.filter(input => hasToken(input, 'username'))
  const userCandidates = usernames.length ? usernames : possibleUsers
  if (userCandidates.length > 1 && username) return 'no-form'
  const userField = userCandidates[0]
  if (passwordField.value || (userField?.value && username && userField.value !== username)) return 'occupied'

  const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  const changes = []
  if (userField && username && !userField.value) {
    valueSetter.call(userField, username)
    changes.push(userField)
  }
  valueSetter.call(passwordField, password)
  changes.push(passwordField)
  for (const input of changes) {
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }
  return 'filled'
}

module.exports = { fillLoginForm }
