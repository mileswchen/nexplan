import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

// scrypt params. Node's defaults (N=16384, r=8, p=1) are used explicitly.
const SCRYPT_N = 16384;
const KEY_LEN = 32;

/** Hash a password with a fresh random salt. Format: `scrypt$<salt>$<hash>`. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, KEY_LEN, { N: SCRYPT_N }).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

/** Constant-time verification against a stored `scrypt$salt$hash` value. */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, hash] = parts;
  const expected = Buffer.from(hash, 'hex');
  const actual = scryptSync(password, salt, KEY_LEN, { N: SCRYPT_N });
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** Random 32-byte hex secret for signing session cookies. */
export function generateSecret(): string {
  return randomBytes(32).toString('hex');
}
