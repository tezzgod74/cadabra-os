// 0.9.10 (REVIEW-0.9.9 H1): deleting Cadabra's folders never follows a symbolic
// link or an NTFS junction. Every test builds REAL links in a temp sandbox and
// checks that the link's target survives. Runs under system Node (`npm test`)
// and under Electron's own Node (`npm run test:electron-node`), where
// fs.rmSync({ recursive: true }) does follow junctions.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { clearHistoryFiles, type HistoryPaths } from '../src/main/history';
import { isLink, safeRemove, UnsafeDeleteError } from '../src/main/safe-delete';

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cadabra-safedel-')));
afterAll(() => {
  // Clean the sandbox with the safe delete itself (it contains junctions).
  safeRemove(tmp, [tmp]);
});

function put(file: string, text = 'keep me') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}
const junction = (target: string, link: string) => {
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(target, link, 'junction');
};
/** File / directory symlinks need Developer Mode or admin on Windows: null when not allowed. */
function trySymlink(target: string, link: string, type: 'file' | 'dir'): boolean {
  fs.mkdirSync(path.dirname(link), { recursive: true });
  try {
    fs.symlinkSync(target, link, type);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EPERM') return false;
    throw e;
  }
}

/** A sandbox: a fake Cadabra install, a fake home and a "precious" folder outside both. */
function world(name: string) {
  const root = path.join(tmp, name);
  const ud = path.join(root, 'Cadabra OS');
  const p: HistoryPaths = {
    userData: ud,
    agentWork: path.join(ud, 'agent-work'),
    codexHome: path.join(ud, 'codex-home'),
    geminiHome: path.join(ud, 'gemini-home'),
    claudeConfig: path.join(ud, 'claude-api-config'),
    e2eReports: path.join(ud, 'e2e-live'),
    temp: path.join(root, 'temp'),
    home: path.join(root, 'home'),
  };
  fs.mkdirSync(p.temp, { recursive: true });
  const precious = path.join(root, 'precious');
  const files = [put(path.join(precious, 'a.txt')), put(path.join(precious, 'deep', 'b.txt'))];
  return { p, precious, files, survived: () => files.every((f) => fs.readFileSync(f, 'utf8') === 'keep me') };
}

describe('0.9.10 safe delete: real junctions and symlinks in temp sandboxes', () => {
  it(`runs under ${process.versions.electron ? `Electron ${process.versions.electron}` : 'system Node'} ${process.versions.node}`, () => {
    // 0.9.11 (REVIEW-0.9.10): the shipped runtime exactly: Electron 44.7.x (Node 24.21, whose rmSync follows junctions).
    if (process.env.CADABRA_EXPECT_ELECTRON) expect(process.versions.electron).toMatch(/^44\.7\.\d+$/);
    expect(isLink(tmp)).toBe(false);
  });

  it('a junction is reported as a link', () => {
    const w = world('islink');
    junction(w.precious, path.join(tmp, 'islink', 'j'));
    expect(isLink(path.join(tmp, 'islink', 'j'))).toBe(true);
    expect(isLink(w.precious)).toBe(false);
  });

  it('Codex sessions folder replaced by a junction: the junction goes, its target survives', () => {
    const w = world('codex');
    junction(w.precious, path.join(w.p.codexHome, 'sessions'));
    const removed = clearHistoryFiles(w.p);
    expect(removed).toContain(path.join(w.p.codexHome, 'sessions'));
    expect(fs.existsSync(path.join(w.p.codexHome, 'sessions'))).toBe(false);
    expect(w.survived()).toBe(true);
  });

  it('a junction nested deep inside Claude projects: the tree goes, the target survives', () => {
    const w = world('nested');
    put(path.join(w.p.claudeConfig, 'projects', 'x', 'session.jsonl'), 'history');
    junction(w.precious, path.join(w.p.claudeConfig, 'projects', 'x', 'sub', 'link'));
    clearHistoryFiles(w.p);
    expect(fs.existsSync(path.join(w.p.claudeConfig, 'projects'))).toBe(false);
    expect(w.survived()).toBe(true);
  });

  it('a junction in the Claude working folder and in Gemini tmp', () => {
    const w = world('cwd');
    junction(w.precious, path.join(w.p.agentWork, 'claude-cwd', 'j'));
    junction(w.precious, path.join(w.p.geminiHome, '.gemini', 'tmp', 'abc', 'j'));
    clearHistoryFiles(w.p);
    expect(fs.existsSync(path.join(w.p.agentWork, 'claude-cwd', 'j'))).toBe(false);
    expect(fs.existsSync(path.join(w.p.geminiHome, '.gemini', 'tmp'))).toBe(false);
    expect(w.survived()).toBe(true);
  });

  it('a whole private home that is a junction to elsewhere is refused (its real path is outside Cadabra’s folder)', () => {
    const w = world('homejunction');
    put(path.join(w.precious, 'sessions', 'r.jsonl'));
    w.files.push(path.join(w.precious, 'sessions', 'r.jsonl'));
    junction(w.precious, w.p.codexHome);
    clearHistoryFiles(w.p);
    expect(w.survived()).toBe(true);
    expect(() => safeRemove(path.join(w.p.codexHome, 'sessions'), [w.p.userData])).toThrow(UnsafeDeleteError);
    expect(w.survived()).toBe(true);
  });

  it('a cadabra-term-* folder in temp that is a junction: only the link goes', () => {
    const w = world('term');
    junction(w.precious, path.join(w.p.temp, 'cadabra-term-deadbeef'));
    const inner = path.join(w.p.temp, 'cadabra-term-cafe');
    put(path.join(inner, 'out.txt'));
    junction(w.precious, path.join(inner, 'j'));
    clearHistoryFiles(w.p, { scope: 'orphans' });
    expect(fs.existsSync(path.join(w.p.temp, 'cadabra-term-deadbeef'))).toBe(false);
    expect(fs.existsSync(inner)).toBe(false);
    expect(w.survived()).toBe(true);
  });

  it('the terminal runner’s own clean-up (safeRemove(dir, [dir])) never follows a junction', () => {
    const w = world('termdirect');
    const dir = path.join(w.p.temp, 'cadabra-term-0123');
    put(path.join(dir, 'out.txt'));
    junction(w.precious, path.join(dir, 'j'));
    expect(safeRemove(dir, [dir])).toBe(true);
    expect(fs.existsSync(dir)).toBe(false);
    expect(w.survived()).toBe(true);
  });

  it('model extract/replace folders (voice/models) with a junction inside', () => {
    const w = world('models');
    const modelsDir = path.join(w.p.userData, 'models');
    const dir = path.join(modelsDir, 'kokoro');
    put(path.join(dir, 'model.onnx'));
    junction(w.precious, path.join(dir, 'espeak-ng-data'));
    const extract = path.join(modelsDir, 'extract-1');
    put(path.join(extract, 'x', 'tokens.txt'));
    junction(w.precious, path.join(extract, 'x', 'j'));
    safeRemove(dir, [modelsDir, w.p.userData]);
    safeRemove(extract, [modelsDir]);
    expect(fs.existsSync(dir)).toBe(false);
    expect(fs.existsSync(extract)).toBe(false);
    expect(w.survived()).toBe(true);
  });

  it('file and directory symlinks (skipped where Windows doesn’t allow creating them)', (ctx) => {
    const w = world('symlinks');
    const dirLink = path.join(w.p.codexHome, 'sessions', 'dirlink');
    const fileLink = path.join(w.p.claudeConfig, 'projects', 'filelink.jsonl');
    put(path.join(w.p.codexHome, 'sessions', 'r.jsonl'), 'history');
    put(path.join(w.p.claudeConfig, 'projects', 'p.jsonl'), 'history');
    if (!trySymlink(w.precious, dirLink, 'dir') || !trySymlink(w.files[0], fileLink, 'file')) return ctx.skip();
    expect(isLink(dirLink)).toBe(true);
    expect(isLink(fileLink)).toBe(true);
    clearHistoryFiles(w.p);
    expect(fs.existsSync(path.join(w.p.codexHome, 'sessions'))).toBe(false);
    expect(fs.existsSync(path.join(w.p.claudeConfig, 'projects'))).toBe(false);
    expect(w.survived()).toBe(true);
  });

  it('a folder swapped for a junction mid-walk: the unlink is refused (parent re-validated before each file; 0.9.11)', () => {
    const w = world('race');
    const victim = path.join(w.p.codexHome, 'sessions');
    put(path.join(victim, 'a.txt'), 'history');
    // Same file name in the precious folder, so an unvalidated unlink would hit it.
    const a = put(path.join(w.precious, 'a.txt'));
    const real = fs.readdirSync;
    const spy = vi.spyOn(fs, 'readdirSync').mockImplementation(((p: fs.PathLike, o?: unknown) => {
      const names = (real as (p: fs.PathLike, o?: unknown) => string[])(p, o);
      if (path.resolve(String(p)) === path.resolve(victim)) {
        // The attacker's move between listing and deleting: swap the folder for a junction.
        fs.renameSync(victim, `${victim}-moved`);
        fs.symlinkSync(w.precious, victim, 'junction');
      }
      return names;
    }) as typeof fs.readdirSync);
    try {
      expect(() => safeRemove(victim, [w.p.userData])).toThrow(UnsafeDeleteError);
    } finally {
      spy.mockRestore();
    }
    expect(fs.readFileSync(a, 'utf8')).toBe('keep me');
    expect(w.survived()).toBe(true);
  });

  it('refuses a target outside the allowed roots, and a link whose parent is outside', () => {
    const w = world('outside');
    expect(() => safeRemove(w.precious, [w.p.userData])).toThrow(UnsafeDeleteError);
    fs.mkdirSync(w.p.userData, { recursive: true });
    const link = path.join(w.p.home!, 'j');
    junction(w.precious, link);
    expect(() => safeRemove(link, [w.p.userData])).toThrow(UnsafeDeleteError);
    expect(() => safeRemove(w.p.userData, [path.join(tmp, 'does-not-exist')])).toThrow(UnsafeDeleteError);
    expect(safeRemove(path.join(w.p.userData, 'missing'), [w.p.userData])).toBe(false);
    expect(w.survived()).toBe(true);
  });

  it('never-touch folders are refused even inside an allowed root', () => {
    const w = world('never');
    const userClaude = path.join(w.p.userData, '.claude');
    put(path.join(userClaude, 'x.json'));
    expect(() => safeRemove(userClaude, [w.p.userData], { never: [userClaude] })).toThrow(UnsafeDeleteError);
    expect(fs.existsSync(path.join(userClaude, 'x.json'))).toBe(true);
  });

  it('no recursive rm / rmSync is left anywhere in src (every tree delete goes through safeRemove)', () => {
    const offenders: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const f = path.join(d, e.name);
        if (e.isDirectory()) walk(f);
        else if (/\.(ts|tsx|mjs|js)$/.test(e.name) && /\b(rm|rmSync|rmdir|rmdirSync|promises\.rm)\([^)]*recursive\s*:\s*true/.test(fs.readFileSync(f, 'utf8'))) offenders.push(f);
      }
    };
    walk(path.resolve('src'));
    expect(offenders).toEqual([]);
  });
});
