import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyPatch, DEFAULT_SETTINGS, mergeSettings, sanitizeRendererPatch } from '../src/shared/settings';
import { SettingsStore, writeFileAtomic, type SecretCipher } from '../src/main/settings-store';

const fakeCipher = (available = true): SecretCipher => ({
  isEncryptionAvailable: () => available,
  encryptString: (s) => Buffer.from(`enc:${Buffer.from(s).toString('base64')}`),
  decryptString: (b) => Buffer.from(b.toString().slice(4), 'base64').toString(),
});

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cadabra-settings-'));

describe('mergeSettings', () => {
  it('returns defaults for garbage', () => {
    expect(mergeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings('nope')).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings([1, 2])).toEqual(DEFAULT_SETTINGS);
  });
  it('keeps valid fields and drops invalid ones', () => {
    const s = mergeSettings({ provider: 'codex', paused: 'yes', motion: 'reduced', models: { codex: 'gpt-6.1-sol', claude: 42 } });
    expect(s.provider).toBe('codex');
    expect(s.paused).toBe(false);
    expect(s.motion).toBe('reduced');
    expect(s.models.codex).toBe('gpt-6.1-sol');
    expect(s.models.claude).toBe(DEFAULT_SETTINGS.models.claude);
  });
  it('rejects unknown providers', () => {
    expect(mergeSettings({ provider: 'skynet' }).provider).toBe('claude');
  });
  it('S11: safety rule lists always come from code defaults; only scalars persist', () => {
    const s = mergeSettings({
      safety: { denylist: [{ process: 'x.exe', mode: 'block' }], riskyWords: [], maxActionsPerRun: 99999, confirmAllActions: true },
    });
    expect(s.safety.denylist).toEqual(DEFAULT_SETTINGS.safety.denylist);
    expect(s.safety.riskyWords).toEqual(DEFAULT_SETTINGS.safety.riskyWords);
    expect(s.safety.maxActionsPerRun).toBe(DEFAULT_SETTINGS.safety.maxActionsPerRun);
    expect(s.safety.confirmAllActions).toBe(true);
  });
  it('S12: the renderer can only patch preference keys', () => {
    const p = sanitizeRendererPatch({ displayName: 'Alex', cli: { claudePath: 'C:/evil.exe' }, safety: { denylist: [], maxActionsPerRun: 500, confirmAllActions: true } });
    expect(p).toMatchObject({ displayName: 'Alex' });
    expect((p as any).cli).toBeUndefined();
    // Round 11: a partial safety patch (only the autonomy level); applyPatch keeps the rest.
    expect(p.safety?.denylist).toBeUndefined();
    expect(p.safety?.maxActionsPerRun).toBeUndefined();
    expect(p.safety?.confirmAllActions).toBe(true);
    expect(p.safety?.autonomy).toBe('every');
    const merged = applyPatch(DEFAULT_SETTINGS, p);
    expect(merged.safety.denylist).toEqual(DEFAULT_SETTINGS.safety.denylist);
    expect(merged.safety.maxActionsPerRun).toBe(DEFAULT_SETTINGS.safety.maxActionsPerRun);
  });
  it('merges voice settings and normalizes the wake word', () => {
    const s = mergeSettings({ voice: { enabled: true, wakeWord: '  Cadabra ', speakReplies: true } });
    expect(s.voice).toEqual({ ...DEFAULT_SETTINGS.voice, enabled: true, wakeWord: 'cadabra', speakReplies: 'always' });
    expect(mergeSettings({ voice: { speakReplies: false } }).voice.speakReplies).toBe('voice');
    expect(mergeSettings({ voice: { speakReplies: 'never', followUpSeconds: 12 } }).voice).toMatchObject({ speakReplies: 'never', followUpSeconds: 12 });
  });
  it('applyPatch merges nested objects', () => {
    const s = applyPatch(DEFAULT_SETTINGS, { models: { ...DEFAULT_SETTINGS.models, claude: 'claude-haiku-5-5' } });
    expect(s.models.claude).toBe('claude-haiku-5-5');
    expect(s.models.demo).toBe('demo-sparkle');
    const v = applyPatch(s, { voice: { ...s.voice, speakReplies: 'always' } });
    expect(v.voice.speakReplies).toBe('always');
    expect(v.models.claude).toBe('claude-haiku-5-5');
  });
  it('does not mutate the defaults', () => {
    const s = mergeSettings({});
    s.safety.denylist.push({ process: 'x', mode: 'block' });
    expect(DEFAULT_SETTINGS.safety.denylist.some((r) => r.process === 'x')).toBe(false);
  });
});

describe('SettingsStore', () => {
  it('persists settings and survives a corrupt file', () => {
    const dir = tmp();
    const a = new SettingsStore(dir, fakeCipher());
    a.update({ provider: 'copilot', launchAtLogin: true });
    const b = new SettingsStore(dir, fakeCipher());
    expect(b.get().provider).toBe('copilot');
    expect(b.get().launchAtLogin).toBe(true);
    fs.writeFileSync(path.join(dir, 'settings.json'), '{not json');
    expect(new SettingsStore(dir, fakeCipher()).get()).toEqual(DEFAULT_SETTINGS);
  });
  it('stores secrets encrypted, never in plaintext', () => {
    const dir = tmp();
    const s = new SettingsStore(dir, fakeCipher());
    s.setSecret('anthropicApiKey', 'sk-ant-secret-123');
    const raw = fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8');
    expect(raw).not.toContain('sk-ant-secret-123');
    expect(new SettingsStore(dir, fakeCipher()).getSecret('anthropicApiKey')).toBe('sk-ant-secret-123');
    s.setSecret('anthropicApiKey', null);
    expect(new SettingsStore(dir, fakeCipher()).hasSecret('anthropicApiKey')).toBe(false);
  });
  it('refuses to store secrets when OS encryption is unavailable', () => {
    const s = new SettingsStore(tmp(), fakeCipher(false));
    expect(() => s.setSecret('anthropicApiKey', 'x')).toThrow(/plaintext/);
  });
  it('notifies listeners', () => {
    const s = new SettingsStore(tmp(), fakeCipher());
    let seen = '';
    s.onChange((x) => (seen = x.provider));
    s.update({ provider: 'demo' });
    expect(seen).toBe('demo');
  });
});

describe('O2: robust persistence', () => {
  it('backs up a corrupt settings.json instead of silently overwriting it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadabra-o2-'));
    fs.writeFileSync(path.join(dir, 'settings.json'), '{ "provider": "codex", oops');
    const s = new SettingsStore(dir, { isEncryptionAvailable: () => false, encryptString: () => Buffer.alloc(0), decryptString: () => '' });
    expect(s.get().provider).toBe(DEFAULT_SETTINGS.provider);
    expect(fs.readFileSync(path.join(dir, 'settings.json.bad'), 'utf8')).toContain('oops');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('retries a rename blocked by a transient EPERM lock', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadabra-o2-'));
    const file = path.join(dir, 'x.json');
    let fails = 2;
    writeFileAtomic(file, '{"a":1}', undefined, (a, b) => {
      if (fails-- > 0) throw Object.assign(new Error('locked'), { code: 'EPERM' });
      fs.renameSync(a, b);
    });
    expect(fs.readFileSync(file, 'utf8')).toBe('{"a":1}');
    // Persistently locked: still written (in place), no throw.
    writeFileAtomic(file, '{"a":2}', undefined, () => {
      throw Object.assign(new Error('locked'), { code: 'EBUSY' });
    });
    expect(fs.readFileSync(file, 'utf8')).toBe('{"a":2}');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
