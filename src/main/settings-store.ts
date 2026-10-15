import fs from 'node:fs';
import path from 'node:path';
import { applyPatch, mergeSettings } from '../shared/settings';
import type { Settings } from '../shared/types';

/** Abstraction over Electron's safeStorage so the store is unit-testable. */
export interface SecretCipher {
  isEncryptionAvailable(): boolean;
  encryptString(s: string): Buffer;
  decryptString(b: Buffer): string;
}

export type SecretKey = 'anthropicApiKey' | 'openaiApiKey' | 'geminiApiKey' | 'githubToken' | 'gmailRefreshToken' | 'gmailClientSecret' | 'gmailAppPassword' | 'whatsappToken';

export class SettingsStore {
  private settings: Settings;
  private secrets: Partial<Record<SecretKey, string>> = {};
  private listeners = new Set<(s: Settings) => void>();
  private readonly file: string;
  private readonly secretsFile: string;

  constructor(
    dir: string,
    private readonly cipher: SecretCipher,
  ) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'settings.json');
    this.secretsFile = path.join(dir, 'secrets.json');
    this.settings = this.load();
    this.loadSecrets();
  }

  private load(): Settings {
    let text: string;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch {
      return mergeSettings(undefined); // first run
    }
    try {
      return mergeSettings(JSON.parse(text));
    } catch {
      // O2: keep the corrupt file for the user instead of silently overwriting it.
      backupCorrupt(this.file);
      return mergeSettings(undefined);
    }
  }

  private loadSecrets() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.secretsFile, 'utf8')) as Record<string, string>;
      if (!this.cipher.isEncryptionAvailable()) return;
      for (const [k, v] of Object.entries(raw)) {
        try {
          this.secrets[k as SecretKey] = this.cipher.decryptString(Buffer.from(v, 'base64'));
        } catch {
          /* unreadable (different user / machine) — ignore */
        }
      }
    } catch {
      /* none yet */
    }
  }

  get(): Settings {
    return structuredClone(this.settings);
  }

  update(patch: Partial<Settings>): Settings {
    this.settings = applyPatch(this.settings, patch);
    this.persist();
    for (const l of this.listeners) l(this.get());
    return this.get();
  }

  onChange(cb: (s: Settings) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private persist() {
    writeFileAtomic(this.file, JSON.stringify(this.settings, null, 2));
  }

  getSecret(key: SecretKey): string | undefined {
    return this.secrets[key];
  }

  hasSecret(key: SecretKey): boolean {
    return !!this.secrets[key];
  }

  /** Stores a secret encrypted with the OS (DPAPI via safeStorage). Refuses to store plaintext. */
  setSecret(key: SecretKey, value: string | null): void {
    if (value && !this.cipher.isEncryptionAvailable()) throw new Error('OS encryption (safeStorage) is unavailable; refusing to store secret in plaintext');
    if (value) this.secrets[key] = value;
    else delete this.secrets[key];
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.secrets)) {
      if (v) out[k] = this.cipher.encryptString(v).toString('base64');
    }
    writeFileAtomic(this.secretsFile, JSON.stringify(out, null, 2), 0o600);
  }
}

function backupCorrupt(file: string) {
  try {
    fs.copyFileSync(file, `${file}.bad`);
  } catch {
    /* best effort */
  }
}

/**
 * O2: write-then-rename, retrying the rename when antivirus / indexers hold a
 * transient lock (EPERM / EBUSY / EACCES), and never surfacing that as an IPC
 * failure: as a last resort the file is written in place.
 */
export function writeFileAtomic(file: string, data: string, mode?: number, rename: (a: string, b: string) => void = fs.renameSync): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data, mode ? { mode } : undefined);
  for (let i = 0; i < 6; i++) {
    try {
      rename(tmp, file);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') throw e;
      const until = Date.now() + 15 * (i + 1);
      while (Date.now() < until) {
        /* brief synchronous back-off (settings writes are tiny and rare) */
      }
    }
  }
  fs.writeFileSync(file, data, mode ? { mode } : undefined);
  fs.rmSync(tmp, { force: true });
}
