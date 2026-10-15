import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Parakeet TDT-CTC 110M int8 (English, punctuated) — downloaded on first voice enable. */
export const ASR_MODEL = {
  name: 'parakeet-110m-int8',
  url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet_tdt_ctc_110m-en-36000-int8.tar.bz2',
  // Pinned: computed from the official release asset on 2026-10-11.
  sha256: '17f945007b52ccd8b7200ffc7c5652e9e8e961dfdf479cefcabd06cf5703630b',
  bytes: 104_337_827,
  folder: 'sherpa-onnx-nemo-parakeet_tdt_ctc_110m-en-36000-int8',
};

export function asrDirFor(userData: string): string {
  return path.join(userData, 'models', ASR_MODEL.name);
}

export function asrInstalled(dir: string): boolean {
  return fs.existsSync(path.join(dir, 'model.int8.onnx')) && fs.existsSync(path.join(dir, 'tokens.txt'));
}

export async function sha256File(file: string): Promise<string> {
  const h = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    fs.createReadStream(file).on('data', (c) => h.update(c)).on('end', resolve).on('error', reject);
  });
  return h.digest('hex');
}

function extract(archive: string, into: string): Promise<void> {
  // Windows 10+ ships bsdtar (System32\tar.exe), which handles .tar.bz2.
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  return new Promise((resolve, reject) => {
    const p = spawn(tar, ['-xjf', archive, '-C', into], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`tar exited ${code}: ${err.trim()}`))));
  });
}

/**
 * Download + verify (SHA-256) + extract the ASR model into userData/models.
 * Resumable: a partial download is continued with an HTTP Range request.
 */
export async function ensureAsrModel(userData: string, onProgress: (pct: number) => void, signal?: AbortSignal): Promise<string> {
  const dir = asrDirFor(userData);
  if (asrInstalled(dir)) return dir;
  const modelsDir = path.join(userData, 'models');
  fs.mkdirSync(modelsDir, { recursive: true });
  const archive = path.join(modelsDir, `${ASR_MODEL.name}.tar.bz2.part`);
  let have = fs.existsSync(archive) ? fs.statSync(archive).size : 0;
  if (have > ASR_MODEL.bytes) {
    fs.rmSync(archive);
    have = 0;
  }
  if (have < ASR_MODEL.bytes) {
    const res = await fetch(ASR_MODEL.url, { headers: have ? { Range: `bytes=${have}-` } : {}, signal, redirect: 'follow' });
    if (!res.ok || !res.body) throw new Error(`Model download failed: HTTP ${res.status}`);
    if (have && res.status !== 206) have = 0; // server ignored Range
    const out = fs.createWriteStream(archive, { flags: have ? 'a' : 'w' });
    let got = have;
    const reader = res.body.getReader();
    let lastPct = -1;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        got += value.length;
        if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()));
        const pct = Math.floor((got / ASR_MODEL.bytes) * 100);
        if (pct !== lastPct) onProgress((lastPct = pct));
      }
    } finally {
      await new Promise<void>((r) => out.end(() => r()));
    }
  }
  const sum = await sha256File(archive);
  if (sum !== ASR_MODEL.sha256) {
    fs.rmSync(archive, { force: true });
    throw new Error('Downloaded model failed its integrity check (SHA-256 mismatch); it was deleted.');
  }
  const tmp = path.join(modelsDir, `extract-${Date.now()}`);
  fs.mkdirSync(tmp, { recursive: true });
  await extract(archive, tmp);
  const src = path.join(tmp, ASR_MODEL.folder);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ['model.int8.onnx', 'tokens.txt']) fs.renameSync(path.join(src, f), path.join(dir, f));
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(archive, { force: true });
  return dir;
}

// ------------------------------------------------------------- natural voice --

/**
 * Kokoro-82M v1.0 (multi-lang, fp32) for sherpa-onnx OfflineTts: British and
 * American English voices. Apache-2.0 (model + voices, hexgrad/Kokoro-82M);
 * the bundled espeak-ng-data is GPL-3.0 (downloaded, not shipped).
 * fp32, not int8: on this PC the int8 export ran at RTF≈0.9 (too slow to
 * stream), fp32 at RTF≈0.15–0.22 (measured 2026-10-12, BUILD_NOTES).
 */
export const TTS_MODEL = {
  name: 'kokoro-v1_0',
  url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_0.tar.bz2',
  // Pinned: GitHub release digest, re-computed locally on 2026-10-12.
  sha256: 'c5f7e2d2caf082bc1d20fb70334a61d99d20b484500aad32e7cf84c128ea3298',
  bytes: 349_906_910,
  folder: 'kokoro-multi-lang-v1_0',
  keep: ['model.onnx', 'voices.bin', 'tokens.txt', 'lexicon-gb-en.txt', 'lexicon-us-en.txt', 'LICENSE', 'espeak-ng-data'],
};

export function ttsDirFor(userData: string): string {
  return path.join(userData, 'models', TTS_MODEL.name);
}

export function ttsInstalled(dir: string): boolean {
  return ['model.onnx', 'voices.bin', 'tokens.txt', 'lexicon-gb-en.txt'].every((f) => fs.existsSync(path.join(dir, f))) && fs.existsSync(path.join(dir, 'espeak-ng-data'));
}

/** Download + verify + extract the Kokoro voice (same resumable path as the ASR model). */
export async function ensureTtsModel(userData: string, onProgress: (pct: number) => void, signal?: AbortSignal): Promise<string> {
  const dir = ttsDirFor(userData);
  if (ttsInstalled(dir)) return dir;
  const modelsDir = path.join(userData, 'models');
  fs.mkdirSync(modelsDir, { recursive: true });
  const archive = path.join(modelsDir, `${TTS_MODEL.name}.tar.bz2.part`);
  await downloadResumable(TTS_MODEL.url, archive, TTS_MODEL.bytes, onProgress, signal);
  const sum = await sha256File(archive);
  if (sum !== TTS_MODEL.sha256) {
    fs.rmSync(archive, { force: true });
    throw new Error('Downloaded voice failed its integrity check (SHA-256 mismatch); it was deleted.');
  }
  const tmp = path.join(modelsDir, `extract-${Date.now()}`);
  fs.mkdirSync(tmp, { recursive: true });
  await extract(archive, tmp);
  const src = path.join(tmp, TTS_MODEL.folder);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const f of TTS_MODEL.keep) if (fs.existsSync(path.join(src, f))) fs.renameSync(path.join(src, f), path.join(dir, f));
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(archive, { force: true });
  return dir;
}

async function downloadResumable(url: string, archive: string, bytes: number, onProgress: (pct: number) => void, signal?: AbortSignal) {
  let have = fs.existsSync(archive) ? fs.statSync(archive).size : 0;
  if (have > bytes) {
    fs.rmSync(archive);
    have = 0;
  }
  if (have >= bytes) return;
  const res = await fetch(url, { headers: have ? { Range: `bytes=${have}-` } : {}, signal, redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`);
  if (have && res.status !== 206) have = 0;
  const out = fs.createWriteStream(archive, { flags: have ? 'a' : 'w' });
  let got = have;
  const reader = res.body.getReader();
  let lastPct = -1;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.length;
      if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()));
      const pct = Math.floor((got / bytes) * 100);
      if (pct !== lastPct) onProgress((lastPct = pct));
    }
  } finally {
    await new Promise<void>((r) => out.end(() => r()));
  }
}
