// 0.9.10 (REVIEW-0.9.9 H1): run the deletion-safety tests under Electron's own
// Node (ELECTRON_RUN_AS_NODE=1 with the bundled electron binary), the runtime
// Cadabra actually ships, whose fs.rmSync follows NTFS junctions. `npm test`
// runs the same files under system Node.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const electron = require('electron'); // the path to the bundled binary
const vitest = path.join(path.dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
const files = process.argv.slice(2);
const r = spawnSync(electron, [vitest, 'run', ...(files.length ? files : ['test/safe_delete.test.ts', 'test/round0_9_9.test.ts'])], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', CADABRA_EXPECT_ELECTRON: '1' },
});
if (r.error) throw r.error;
process.exit(r.status ?? 1);
