import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// REVIEW-5 #10: pin the root to this folder's real path with an upper-case
// drive letter, so a run started from "f:\…" or "/f/…" doesn't load the same
// modules twice under two spellings ("Vitest failed to find the current suite").
const here = fs.realpathSync.native(path.dirname(fileURLToPath(import.meta.url))).replace(/^[a-z]:/, (d) => d.toUpperCase());

export default defineConfig({
  root: here,
  test: {
    root: here,
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
