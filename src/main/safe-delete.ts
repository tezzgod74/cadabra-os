// 0.9.10 (REVIEW-0.9.9 H1): a recursive delete that never follows links.
// A recursive `fs.rmSync` under Electron 44.7's Node (24.21)
// follows NTFS junctions, so a junction inside one of Cadabra's folders could
// make "Clear chat history" delete the junction's TARGET. This walks the tree
// with lstat: a symbolic link or junction (or any directory readlink can read,
// i.e. another reparse point) is removed as a link only and never entered.
// The real path of every directory is re-checked against the allowed roots
// right before its children are removed and again before it is removed (Node
// has no delete-by-handle, so this narrows the race window and fails closed).
// Every recursive delete in Cadabra goes through here.

import fs from 'node:fs';
import path from 'node:path';

export class UnsafeDeleteError extends Error {}

/** Is this entry a link (symbolic link, junction or other reparse point readlink can read)? */
export function isLink(p: string, st?: fs.Stats): boolean {
  const s = st ?? fs.lstatSync(p);
  if (s.isSymbolicLink()) return true;
  if (!s.isDirectory()) return false;
  try {
    fs.readlinkSync(p);
    return true;
  } catch {
    return false;
  }
}

const fold = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
const within = (child: string, parent: string) => {
  const rel = path.relative(fold(parent), fold(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

const real = (p: string): string | null => {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
};

interface Guard {
  roots: string[];
  never: string[];
}

/** The real path of `p` must be inside an allowed root and not inside a never-touch folder. */
function assertSafe(p: string, g: Guard): void {
  const r = real(p);
  if (!r) throw new UnsafeDeleteError(`can't resolve ${p}`);
  if (!g.roots.some((root) => within(r, root))) throw new UnsafeDeleteError(`${p} resolves outside Cadabra's folders`);
  if (g.never.some((n) => within(r, n))) throw new UnsafeDeleteError(`${p} resolves into a protected folder`);
}

/** Remove a link itself, never its target (unlink, or a non-recursive rmdir for directory links/junctions). */
function removeLink(p: string): void {
  try {
    fs.unlinkSync(p);
  } catch {
    fs.rmdirSync(p);
  }
}

function removeTree(p: string, g: Guard, child = false): void {
  const st = fs.lstatSync(p);
  if (!st.isDirectory() || isLink(p, st)) {
    // 0.9.11 (REVIEW-0.9.10): re-validate the containing folder's real path right before each
    // unlink, so a folder swapped for a junction mid-walk can't redirect it.
    if (child) assertSafe(path.dirname(p), g);
    if (!st.isDirectory() && !st.isSymbolicLink()) return fs.unlinkSync(p); // a hard link: only this name goes
    return removeLink(p);
  }
  assertSafe(p, g); // re-validate right before touching its children
  for (const name of fs.readdirSync(p)) removeTree(path.join(p, name), g, true);
  assertSafe(p, g);
  fs.rmdirSync(p);
}

export interface SafeRemoveOptions {
  /** Real-path prefixes that must never be touched (e.g. the user's own ~/.claude). */
  never?: readonly string[];
}

/**
 * Delete `target` (a file, a folder tree or a link) without ever following a link.
 * A link is removed as a link (its parent folder must be inside an allowed root);
 * anything else must itself resolve inside one of `allowedRoots` (a root may be
 * the target itself). Returns false if it didn't exist; throws UnsafeDeleteError
 * when it isn't allowed. Children that fail are left and the error is thrown.
 */
export function safeRemove(target: string, allowedRoots: readonly string[], o: SafeRemoveOptions = {}): boolean {
  const g: Guard = {
    roots: allowedRoots.map(real).filter((r): r is string => !!r),
    never: (o.never ?? []).map((n) => real(n) ?? path.resolve(n)),
  };
  if (!allowedRoots.length) throw new UnsafeDeleteError('no allowed roots');
  let st: fs.Stats;
  try {
    st = fs.lstatSync(target);
  } catch {
    return false;
  }
  if (isLink(target, st)) {
    // Removing a link touches only that name. Allowed when its folder is inside a root, or when the
    // root named is the target itself (an exact temp folder like cadabra-term-*, replaced by a link).
    const named = allowedRoots.some((r) => fold(path.resolve(r)) === fold(path.resolve(target)));
    if (!named) assertSafe(path.dirname(target), g);
    removeLink(target);
    return true;
  }
  assertSafe(target, g);
  removeTree(target, g);
  return true;
}
