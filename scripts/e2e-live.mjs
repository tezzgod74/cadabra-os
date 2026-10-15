/* global process, console */
// npm run e2e:live -- --provider claude|claude-code|codex|gemini
// Launches Cadabra in live-readiness mode (see src/main/e2e-live.ts).
import { spawn } from 'node:child_process';
import electron from 'electron';

const i = process.argv.indexOf('--provider');
const provider = i > 0 ? process.argv[i + 1] : process.argv.find((a) => a.startsWith('--provider='))?.split('=')[1];
if (!provider || !['claude', 'claude-code', 'codex', 'gemini'].includes(provider)) {
  console.error('Usage: npm run e2e:live -- --provider claude|claude-code|codex|gemini');
  process.exit(2);
}
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, ['.', `--e2e-live=${provider}`], { stdio: 'inherit', env });
child.on('exit', (code) => process.exit(code ?? 0));
