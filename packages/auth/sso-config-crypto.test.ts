import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  decryptSsoSecret,
  encryptSsoSecret,
  isSsoCryptoConfigured,
} from './src/sso-config-crypto';

function randomKeyB64(): string {
  return crypto.randomBytes(32).toString('base64');
}

describe('sso-config-crypto', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.SSO_CONFIG_ENCRYPTION_KEY;
    delete process.env.SSO_CONFIG_ENCRYPTION_KEY_PREV;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('isSsoCryptoConfigured returns false without the key', () => {
    expect(isSsoCryptoConfigured()).toBe(false);
  });

  it('isSsoCryptoConfigured returns true once the key is set', () => {
    process.env.SSO_CONFIG_ENCRYPTION_KEY = randomKeyB64();
    expect(isSsoCryptoConfigured()).toBe(true);
  });

  it('round-trips a secret', () => {
    process.env.SSO_CONFIG_ENCRYPTION_KEY = randomKeyB64();
    const secret = 'sec_oidc_topsecret_!@#$%^&*()';
    const blob = encryptSsoSecret(secret);
    expect(blob).toBeInstanceOf(Buffer);
    // 12-byte iv + ciphertext + 16-byte authTag = at least IV+TAG+1 byte
    expect(blob.length).toBeGreaterThanOrEqual(12 + 16 + 1);
    expect(decryptSsoSecret(blob)).toBe(secret);
  });

  it('produces a different ciphertext on each call (fresh IV)', () => {
    process.env.SSO_CONFIG_ENCRYPTION_KEY = randomKeyB64();
    const a = encryptSsoSecret('same-secret');
    const b = encryptSsoSecret('same-secret');
    expect(a.equals(b)).toBe(false);
  });

  it('rejects truncated payloads loudly', () => {
    process.env.SSO_CONFIG_ENCRYPTION_KEY = randomKeyB64();
    expect(() => decryptSsoSecret(Buffer.alloc(5))).toThrow(/truncated/i);
  });

  it('rejects a tampered ciphertext (GCM auth tag fails)', () => {
    process.env.SSO_CONFIG_ENCRYPTION_KEY = randomKeyB64();
    const blob = encryptSsoSecret('original');
    // Flip a byte in the middle of the ciphertext region. Use
    // writeUInt8 instead of bracket-indexing so noUncheckedIndexedAccess
    // / `Object is possibly 'undefined'` doesn't trip us.
    const mid = Math.floor(blob.length / 2);
    blob.writeUInt8(blob.readUInt8(mid) ^ 0xff, mid);
    expect(() => decryptSsoSecret(blob)).toThrow(/failed under all configured keys/);
  });

  it('falls back to PREV key during rotation', () => {
    // Write under the original key.
    const keyA = randomKeyB64();
    process.env.SSO_CONFIG_ENCRYPTION_KEY = keyA;
    const blob = encryptSsoSecret('rotation-test');

    // Promote a NEW active key; move keyA to PREV.
    process.env.SSO_CONFIG_ENCRYPTION_KEY = randomKeyB64();
    process.env.SSO_CONFIG_ENCRYPTION_KEY_PREV = keyA;
    expect(decryptSsoSecret(blob)).toBe('rotation-test');

    // Dropping PREV before re-encrypting breaks reads — this is the
    // expected failure mode that drives the migration job design.
    delete process.env.SSO_CONFIG_ENCRYPTION_KEY_PREV;
    expect(() => decryptSsoSecret(blob)).toThrow(/failed under all configured keys/);
  });

  it('refuses to encrypt without a key', () => {
    expect(() => encryptSsoSecret('x')).toThrow(/SSO_CONFIG_ENCRYPTION_KEY is required/);
  });

  it('rejects a wrong-length key', () => {
    process.env.SSO_CONFIG_ENCRYPTION_KEY = Buffer.from('too-short').toString(
      'base64',
    );
    expect(() => encryptSsoSecret('x')).toThrow(/expected 32-byte key/);
  });
});
