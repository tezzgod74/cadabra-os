// 0.9.9 ("I should have an option to clear chat history"): the on-disk part of
// "Clear chat history". Only Cadabra's OWN private folders are touched, and
// only the files that can hold conversation content or per-session secrets.
// The user's own ~/.claude, ~/.codex, ~/.gemini and ~/.copilot are never
// touched, and sign-ins (Codex auth.json, Gemini OAuth files), settings,
// skills, keys and pairing are kept. Inventory: internal/BUILD_NOTES.md (0.9.9).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { safeRemove } from './safe-delete';

export interface HistoryPaths {
  /** %APPDATA%\Cadabra OS */
  userData: string;
  /** userData\agent-work (backend working files) */
  agentWork: string;
  /** Cadabra's private CODEX_HOME */
  codexHome: string;
  /** Cadabra's private GEMINI_CLI_HOME */
  geminiHome: string;
  /** Cadabra's private CLAUDE_CONFIG_DIR (API-key / Bedrock / Vertex routes) */
  claudeConfig: string;
  /** userData\e2e-live (live-readiness reports: prompts and replies) */
  e2eReports: string;
  /** The system temp folder (terminal output: cadabra-term-*) */
  temp: string;
  /** The user's home (only used to make sure nothing under their own CLI folders is touched) */
  home?: string;
}

/** Folders that belong to the user's own CLIs: never touched. */
export function protectedDirs(home = os.homedir()): string[] {
  return ['.claude', '.codex', '.gemini', '.copilot', '.config'].map((d) => path.join(home, d));
}

const TERM_DIR = /^cadabra-term-[0-9a-f]+$/i;

const inside = (child: string, parent: string) => {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
};

/**
 * What to remove. 'all' = everything "Clear chat history" removes; 'orphans' =
 * only leftover per-session temp files (MCP/prompt/hook files, screenshots
 * handed to Codex, terminal output), never conversation history (0.9.10 M1).
 */
export type HistoryScope = 'all' | 'orphans';

export function historyTargets(p: HistoryPaths, scope: HistoryScope = 'all'): { path: string; why: string }[] {
  const t: { path: string; why: string }[] = [];
  const list = (dir: string) => {
    try {
      return fs.readdirSync(dir);
    } catch {
      return [] as string[];
    }
  };
  // Backend working files: per-session MCP config (bearer token), hook settings, prompt
  // copies, screenshots handed to Codex, the empty Claude Code working folder's contents.
  for (const f of list(p.agentWork)) {
    if (/^claude-(mcp|prompt|settings)-[0-9a-f]+\.(json|txt)$/i.test(f) || /^screen-\d+\.png$/i.test(f)) t.push({ path: path.join(p.agentWork, f), why: 'backend session file' });
  }
  // Terminal output captured from run_in_terminal (normally removed after 5 s).
  for (const f of list(p.temp)) if (TERM_DIR.test(f)) t.push({ path: path.join(p.temp, f), why: 'terminal output' });
  if (scope === 'orphans') return t.filter((x) => fs.existsSync(x.path));
  for (const f of list(path.join(p.agentWork, 'claude-cwd'))) t.push({ path: path.join(p.agentWork, 'claude-cwd', f), why: 'backend working folder' });
  // Gemini's private workspace and home: chats, logs and checkpoints (not its sign-in).
  for (const f of ['tmp', 'history', 'logs.json']) t.push({ path: path.join(p.geminiHome, '.gemini', f), why: 'Gemini session history' });
  // Codex's private home: session rollouts and history (not auth.json / config.toml).
  for (const f of ['sessions', 'archived_sessions', 'history.jsonl', 'log']) t.push({ path: path.join(p.codexHome, f), why: 'Codex session history' });
  // Claude Code's private config (API-key routes): everything it keeps per session.
  for (const f of ['projects', 'todos', 'file-history', 'session-env', 'sessions', 'shell-snapshots', 'plans', 'history.jsonl', 'statsig', '.claude.json']) t.push({ path: path.join(p.claudeConfig, f), why: 'Claude Code session history' });
  // Live-readiness reports (they contain test prompts and replies).
  for (const f of list(p.e2eReports)) t.push({ path: path.join(p.e2eReports, f), why: 'test report' });
  return t.filter((x) => fs.existsSync(x.path));
}

/**
 * Remove the targets. `scope` picks 'all' (default) or only orphaned temp files;
 * `olderThanMs` limits it to entries untouched for that long. Deletion never
 * follows a symbolic link or junction (safeRemove; 0.9.10 H1): a link is removed
 * as a link, and every folder must really be inside Cadabra's data folder (or be
 * the cadabra-term-* folder itself). Returns what was removed.
 */
export function clearHistoryFiles(p: HistoryPaths, o: { olderThanMs?: number; now?: number; scope?: HistoryScope } = {}): string[] {
  const now = o.now ?? Date.now();
  const guard = protectedDirs(p.home);
  const removed: string[] = [];
  for (const t of historyTargets(p, o.scope ?? 'all')) {
    // Belt and braces: only inside Cadabra's own folders or cadabra-term-* in temp; never the user's CLI folders.
    const term = inside(t.path, p.temp) && path.dirname(path.resolve(t.path)) === path.resolve(p.temp) && TERM_DIR.test(path.basename(t.path));
    const ours = inside(t.path, p.userData) || term;
    if (!ours || guard.some((g) => t.path === g || inside(t.path, g))) continue;
    if (o.olderThanMs != null) {
      try {
        if (now - fs.lstatSync(t.path).mtimeMs < o.olderThanMs) continue;
      } catch {
        continue;
      }
    }
    try {
      // The temp folder itself is never an allowed root: only that exact cadabra-term-* folder.
      if (safeRemove(t.path, term ? [t.path] : [p.userData], { never: guard })) removed.push(t.path);
    } catch {
      /* in use, or resolves outside Cadabra's folders: left alone */
    }
  }
  return removed;
}

/** What the startup sweep removes for each "Keep chat history" choice (0.9.10 M1). */
export function startupSweep(mode: KeepHistory): { scope: HistoryScope; olderThanMs?: number } {
  if (mode === 'on-close') return { scope: 'all' }; // the user chose to clear on close: finish a missed clear
  if (mode === 'idle-1h') return { scope: 'all', olderThanMs: IDLE_CLEAR_MS }; // past the idle window by definition
  return { scope: 'orphans', olderThanMs: ORPHAN_AGE_MS }; // "until I clear it": only leftover temp files
}

/** Orphaned temp files are always cleaned after a day. */
export const ORPHAN_AGE_MS = 24 * 60 * 60 * 1000;
/** "Clear after 1 hour of inactivity". */
export const IDLE_CLEAR_MS = 60 * 60 * 1000;

export type KeepHistory = 'until-cleared' | 'on-close' | 'idle-1h';

/** Should the idle timer clear now? (Pure; tested.) */
export function idleClearDue(mode: KeepHistory, lastActivity: number | null, now: number, busy: boolean): boolean {
  return mode === 'idle-1h' && !busy && lastActivity != null && now - lastActivity >= IDLE_CLEAR_MS;
}

/** The honest note shown before clearing (panel card, WhatsApp, README). */
export const CLEAR_HISTORY_NOTE =
  'Removes your conversations from Cadabra on this PC: the panel, the WhatsApp conversation context, the AI sessions (they start fresh) and Cadabra’s own session and temp files. Keeps your settings, skills, keys and WhatsApp pairing. It can’t remove copies outside this PC: the chat on your phone (delete it in WhatsApp; Meta keeps agent messages for up to 30 days) and whatever your AI provider keeps under its own policy. GitHub Copilot keeps its sessions in your own ~/.copilot folder, which Cadabra doesn’t clear.';
