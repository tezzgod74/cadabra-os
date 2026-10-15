// Release build of native/cadabra-helper with reproducible-ish paths: the
// builder's home folder, CARGO_HOME and the repo root are remapped so the
// shipped exe doesn't embed them (panic locations, debug strings).
// The paths are computed here from the environment, never hardcoded.
//   node scripts/build-helper.mjs [extra cargo args]
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = os.homedir();
const cargoHome = process.env.CARGO_HOME || path.join(home, '.cargo');
const rustupHome = process.env.RUSTUP_HOME || path.join(home, '.rustup');

// rustc applies the LAST matching remap, so list the broadest prefix first.
const remaps = [
  [home, '/home'],
  [rustupHome, '/rustup'],
  [cargoHome, '/cargo'],
  [root, '/src'],
];
const flags = remaps.map(([from, to]) => `--remap-path-prefix=${from}=${to}`);
// CARGO_ENCODED_RUSTFLAGS (0x1f-separated) keeps paths with spaces intact.
const existing = process.env.CARGO_ENCODED_RUSTFLAGS
  ? process.env.CARGO_ENCODED_RUSTFLAGS.split('\x1f')
  : (process.env.RUSTFLAGS ?? '').split(/\s+/).filter(Boolean);
const encoded = [...existing, ...flags].join('\x1f');

const args = ['build', '--release', '--manifest-path', path.join(root, 'native', 'cadabra-helper', 'Cargo.toml'), ...process.argv.slice(2)];
const env = { ...process.env, CARGO_ENCODED_RUSTFLAGS: encoded };
delete env.RUSTFLAGS;
const r = spawnSync('cargo', args, { stdio: 'inherit', env, shell: false });
process.exit(r.status ?? 1);
