import { z } from 'zod'

/**
 * Passwords in shared session text are sealed with a passphrase the sender picks and tells the other
 * person some other way (phone, in person). No key ships with the app: anyone who has ezShell could
 * read a built-in key out of it. PBKDF2-SHA256 → AES-256-GCM, fresh salt and iv each time. The plain
 * part of the token is the additional data, so a token whose host was swapped will not open.
 */
export const PBKDF2_ITERATIONS = 600_000
export const PASSPHRASE_MIN = 10
export const PASSPHRASE_MAX = 200
// A token picks its own count: too low makes guessing cheap, too high freezes the window
const MIN_ITERATIONS = 100_000
const MAX_ITERATIONS = 2_000_000
const SALT_BYTES = 16
const IV_BYTES = 12

export interface SecretBox {
  salt: string
  iv: string
  iter: number
  data: string
}

const b64url = (min: number, max: number) => z.string().min(min).max(max).regex(/^[A-Za-z0-9_-]+$/)

export const secretBoxSchema = z.object({
  salt: b64url(22, 22),
  iv: b64url(16, 16),
  iter: z.number().int().min(MIN_ITERATIONS).max(MAX_ITERATIONS),
  data: b64url(1, 2 * 1024 * 1024)
})

/** Wrong passphrase, or the text was changed after it was made */
export class ShareUnlockError extends Error {
  constructor() {
    super('공유 암호가 맞지 않거나 텍스트가 바뀌었습니다.')
    this.name = 'ShareUnlockError'
  }
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function base64UrlToBytes(text: string): Uint8Array<ArrayBuffer> {
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

const encoder = new TextEncoder()

async function deriveKey(passphrase: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<CryptoKey> {
  // NFC: the same Hangul passphrase typed on macOS (NFD) and Windows (NFC) must give the same key
  const material = await crypto.subtle.importKey('raw', encoder.encode(passphrase.normalize('NFC')), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

// No 0/O, 1/l/I: the passphrase is read out over the phone
const PASSPHRASE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'

/** A random passphrase like `k7mq-2xpa-vh9t-c3wn` (about 79 bits) */
export function generatePassphrase(): string {
  const groups: string[] = []
  const random = crypto.getRandomValues(new Uint32Array(16))
  for (let g = 0; g < 4; g++) {
    groups.push(Array.from(random.subarray(g * 4, g * 4 + 4), n => PASSPHRASE_ALPHABET[n % PASSPHRASE_ALPHABET.length]).join(''))
  }
  return groups.join('-')
}

/** Seals `value` (JSON) for `passphrase`, bound to `aad` (the token's plain part) */
export async function sealSecrets(value: unknown, passphrase: string, aad: string): Promise<SecretBox> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const key = await deriveKey(passphrase, salt, PBKDF2_ITERATIONS)
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(aad) },
    key,
    encoder.encode(JSON.stringify(value))
  )
  return {
    salt: bytesToBase64Url(salt),
    iv: bytesToBase64Url(iv),
    iter: PBKDF2_ITERATIONS,
    data: bytesToBase64Url(new Uint8Array(sealed))
  }
}

/** Opens a box made by sealSecrets. Throws ShareUnlockError for a wrong passphrase or changed text. */
export async function openSecrets(box: SecretBox, passphrase: string, aad: string): Promise<unknown> {
  let plain: ArrayBuffer
  try {
    const key = await deriveKey(passphrase, base64UrlToBytes(box.salt), box.iter)
    plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64UrlToBytes(box.iv), additionalData: encoder.encode(aad) },
      key,
      base64UrlToBytes(box.data)
    )
  } catch {
    throw new ShareUnlockError()
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain))
  } catch {
    throw new ShareUnlockError()
  }
}
