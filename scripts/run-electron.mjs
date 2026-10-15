// Launch Electron with a clean environment. Some hosts (e.g. tools that are
// themselves Electron apps) export ELECTRON_RUN_AS_NODE=1, which makes
// electron.exe behave like plain Node and breaks `electron .`.
import { spawn } from 'node:child_process';
import electron from 'electron';

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, ['.', ...process.argv.slice(2)], { stdio: 'inherit', env });
child.on('exit', (code) => process.exit(code ?? 0));
