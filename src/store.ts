import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';
import { accountsPath, keyPath, stateDir } from './config.js';

/**
 * One connected Google account. This is the plain-object replacement for
 * Noteward's Eloquent GoogleAccount model — same fields the connectors read.
 * refreshToken / accessToken are held in memory in the clear; they are only
 * ever encrypted when written to disk (see AccountStore).
 */
export interface Account {
  label: string;
  email: string;
  refreshToken: string;
  accessToken: string;
  /** Unix epoch millis. null = unknown / force refresh. */
  expiresAt: number | null;
  scopes: string[];
  isDefault: boolean;
}

interface Envelope {
  v: 1;
  /** base64 iv */
  iv: string;
  /** base64 auth tag */
  tag: string;
  /** base64 ciphertext of JSON.stringify(Account[]) */
  data: string;
}

const ALGO = 'aes-256-gcm';

/**
 * File-backed, encrypted-at-rest account store. Tokens are sealed with
 * AES-256-GCM under a 32-byte key generated on first use and stored mode 0600
 * alongside the data. This is machine-local encryption — it protects the token
 * file from casual disk reads / backups, not from someone who already has read
 * access to your home directory. That matches the threat model of a personal
 * CLI (the same posture as an ~/.aws/credentials file, but sealed).
 */
export class AccountStore {
  private accounts: Account[];

  private constructor(accounts: Account[]) {
    this.accounts = accounts;
  }

  static load(): AccountStore {
    ensureStateDir();
    const path = accountsPath();
    if (!existsSync(path)) {
      return new AccountStore([]);
    }

    const envelope = JSON.parse(readFileSync(path, 'utf8')) as Envelope;
    const key = loadOrCreateKey();
    const decipher = createDecipheriv(ALGO, key, Buffer.from(envelope.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.data, 'base64')),
      decipher.final(),
    ]).toString('utf8');

    return new AccountStore(JSON.parse(plaintext) as Account[]);
  }

  /** All accounts, tokens redacted — safe to print. */
  list(): Array<Omit<Account, 'refreshToken' | 'accessToken'>> {
    return this.accounts.map(({ refreshToken: _r, accessToken: _a, ...rest }) => rest);
  }

  /**
   * Resolve an account by label, or the default when label is empty/undefined.
   * Mirrors Noteward's ResolvesAccount trait. Throws with actionable guidance.
   */
  resolve(label?: string | null): Account {
    const trimmed = (label ?? '').trim();

    if (trimmed === '') {
      const def = this.accounts.find((a) => a.isDefault) ?? this.accounts[0];
      if (!def) {
        throw new Error('No Google account connected. Run `gmail auth` first.');
      }
      return def;
    }

    const match = this.accounts.find((a) => a.label === trimmed);
    if (!match) {
      const known = this.accounts.map((a) => a.label).join(', ') || '(none)';
      throw new Error(`No account with label "${trimmed}". Connected: ${known}.`);
    }
    return match;
  }

  /**
   * Upsert an account by label. The first account added becomes the default.
   * Re-connecting an existing label overwrites its tokens but preserves its
   * default flag.
   */
  upsert(account: Omit<Account, 'isDefault'>): Account {
    const existing = this.accounts.find((a) => a.label === account.label);
    const isDefault = existing ? existing.isDefault : this.accounts.length === 0;
    const next: Account = { ...account, isDefault };

    if (existing) {
      Object.assign(existing, next);
      this.save();
      return existing;
    }

    this.accounts.push(next);
    this.save();
    return next;
  }

  /** Persist token changes made in-place (e.g. after a refresh). */
  persist(): void {
    this.save();
  }

  setDefault(label: string): void {
    const target = this.accounts.find((a) => a.label === label);
    if (!target) {
      throw new Error(`No account with label "${label}".`);
    }
    for (const a of this.accounts) {
      a.isDefault = a.label === label;
    }
    this.save();
  }

  remove(label: string): void {
    const before = this.accounts.length;
    this.accounts = this.accounts.filter((a) => a.label !== label);
    if (this.accounts.length === before) {
      throw new Error(`No account with label "${label}".`);
    }
    // If we removed the default, promote the first remaining account.
    if (this.accounts.length > 0 && !this.accounts.some((a) => a.isDefault)) {
      this.accounts[0]!.isDefault = true;
    }
    this.save();
  }

  private save(): void {
    ensureStateDir();
    const key = loadOrCreateKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGO, key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(this.accounts), 'utf8'),
      cipher.final(),
    ]);
    const envelope: Envelope = {
      v: 1,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: ciphertext.toString('base64'),
    };
    const path = accountsPath();
    writeFileSync(path, JSON.stringify(envelope), { mode: 0o600 });
    chmodSafe(path);
  }
}

function ensureStateDir(): void {
  const dir = stateDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

/**
 * Load the machine-local encryption key, generating it on first use. Stored
 * mode 0600. Not derived from a passphrase by design — a personal CLI can't
 * prompt for one on every non-interactive MCP call.
 */
function loadOrCreateKey(): Buffer {
  ensureStateDir();
  const path = keyPath();
  if (existsSync(path)) {
    return Buffer.from(readFileSync(path, 'utf8'), 'base64');
  }
  const key = randomBytes(32);
  writeFileSync(path, key.toString('base64'), { mode: 0o600 });
  chmodSafe(path);
  return key;
}

/** chmod is a no-op on Windows; swallow errors so the tool still works there. */
function chmodSafe(path: string): void {
  try {
    chmodSync(path, 0o600);
  } catch {
    /* Windows / unsupported fs — ignore. */
  }
}
