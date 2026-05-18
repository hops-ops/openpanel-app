// ---------------------------------------------------------------------------
// AES-256-GCM at-rest encryption for OrganizationSsoConfig.oidcClientSecret.
//
// The plaintext lives only on the api process during an OAuth flow; it is
// never stored as plaintext in the DB and never returned to the
// dashboard client (the admin UI shows `••••` once a secret is set).
//
// Wire format: [12-byte IV] || [ciphertext] || [16-byte GCM auth tag]
//
// Key material comes from `SSO_CONFIG_ENCRYPTION_KEY` (32 bytes,
// base64-encoded). Rotation support: an optional
// `SSO_CONFIG_ENCRYPTION_KEY_PREV` is consulted on decrypt failures so
// a key rollover can re-encrypt rows under the new key without a
// downtime window. Once all rows have been re-encrypted, the operator
// drops PREV.
//
// Required env vars are validated lazily on first use. The api server
// boots fine with neither key set; the throw happens only when a code
// path tries to read or write an `oidcClientSecretEncrypted` field.
// ---------------------------------------------------------------------------

import crypto from 'node:crypto';

const ALGO = 'aes-256-gcm';
const KEY_LEN = 32;
const IV_LEN = 12;
const TAG_LEN = 16;

function loadKeyFromEnv(envVar: string): Buffer | null {
  const raw = process.env[envVar];
  if (!raw) return null;
  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== KEY_LEN) {
    throw new Error(
      `${envVar}: expected ${KEY_LEN}-byte key (base64-encoded); got ${buf.length} bytes`,
    );
  }
  return buf;
}

function activeKey(): Buffer {
  const k = loadKeyFromEnv('SSO_CONFIG_ENCRYPTION_KEY');
  if (!k) {
    throw new Error(
      'SSO_CONFIG_ENCRYPTION_KEY is required to encrypt or decrypt OrganizationSsoConfig secrets. ' +
        'Generate with `openssl rand -base64 32`.',
    );
  }
  return k;
}

function prevKey(): Buffer | null {
  return loadKeyFromEnv('SSO_CONFIG_ENCRYPTION_KEY_PREV');
}

/**
 * Encrypts an SSO config client_secret under the active key. The
 * returned Buffer is `iv || ciphertext || authTag` — store it as a
 * Postgres BYTEA via Prisma's `Bytes` mapped type.
 */
export function encryptSsoSecret(plaintext: string): Buffer {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, activeKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, ciphertext, authTag]);
}

/**
 * Decrypts an SSO config client_secret. Tries the active key first,
 * then falls back to the PREV key when set so a rotated row can still
 * be read. Throws if both keys fail or if the wire format is
 * truncated — never returns `null` so callers can't silently treat
 * a tamper as an empty secret.
 */
export function decryptSsoSecret(blob: Buffer): string {
  if (blob.length < IV_LEN + TAG_LEN + 1) {
    throw new Error(
      `decryptSsoSecret: truncated payload (got ${blob.length} bytes; need at least ${
        IV_LEN + TAG_LEN + 1
      })`,
    );
  }
  const iv = blob.subarray(0, IV_LEN);
  const authTag = blob.subarray(blob.length - TAG_LEN);
  const ciphertext = blob.subarray(IV_LEN, blob.length - TAG_LEN);

  const keys: Buffer[] = [activeKey()];
  const prev = prevKey();
  if (prev) keys.push(prev);

  let lastErr: unknown;
  for (const key of keys) {
    try {
      const decipher = crypto.createDecipheriv(ALGO, key, iv);
      decipher.setAuthTag(authTag);
      const plaintext = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);
      return plaintext.toString('utf8');
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `decryptSsoSecret: failed under all configured keys (${
      keys.length === 1 ? 'active' : 'active + PREV'
    }); ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
  );
}

/**
 * True when the active key is set. Used by callers that need to gate
 * UI ("SSO is not configured on this install") without throwing on
 * read.
 */
export function isSsoCryptoConfigured(): boolean {
  return !!process.env.SSO_CONFIG_ENCRYPTION_KEY;
}
