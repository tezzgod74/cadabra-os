// Downloads the real ~100 MB speech model, verifies the pinned SHA-256 and
// extracts it with Windows' tar.exe. Opt-in: CADABRA_TEST_DOWNLOAD=1
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { asrInstalled, ensureAsrModel } from '../src/main/voice/models';

describe.skipIf(process.env.CADABRA_TEST_DOWNLOAD !== '1')('speech model download', () => {
  it('downloads, verifies and extracts Parakeet', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadabra-dl-'));
    let last = -1;
    const t0 = Date.now();
    const out = await ensureAsrModel(dir, (p) => (last = p));
    console.log('downloaded+verified+extracted in', Date.now() - t0, 'ms');
    expect(last).toBe(100);
    expect(asrInstalled(out)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 600_000);
});
