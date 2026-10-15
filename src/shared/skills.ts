// 0.9.5: Skills. A skill is a folder with a SKILL.md: YAML-style frontmatter
// (name, description, optional examples / voice / requires) followed by
// Markdown instructions, plus optional small reference files. Skills are
// instructions only: nothing in them is ever executed, and they can't change
// Cadabra's safety rules (docs/SKILLS.md, docs/SECURITY.md).
//
// Pure helpers here (parsing, validation, matching); the folders, enable state
// and hot reload live in src/main/skills.ts.

import { normalizeUtterance } from './intents';

/** Size limits (bytes). */
export const SKILL_MD_MAX = 32 * 1024;
export const SKILL_FILE_MAX = 16 * 1024;
export const SKILL_FILES_MAX = 8;
export const SKILL_FILES_TOTAL_MAX = 48 * 1024;
/** Cap on what use_skill returns to the model. */
export const SKILL_OUTPUT_MAX = 64 * 1024;
/** Extra files a skill may include (reference text only). */
export const SKILL_FILE_EXTENSIONS = ['.md', '.txt', '.csv'];

export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{1,47}$/;

export interface SkillMeta {
  name: string;
  description: string;
  examples: string[];
  voice?: string;
  requires: string[];
}

export interface ParsedSkill {
  meta: SkillMeta | null;
  body: string;
  errors: string[];
  warnings: string[];
}

const KNOWN_KEYS = ['name', 'description', 'examples', 'voice', 'requires'];

function unquote(v: string): string {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"') && t.length >= 2) || (t.startsWith("'") && t.endsWith("'") && t.length >= 2)) return t.slice(1, -1);
  return t;
}

/**
 * A small, forgiving parser for the frontmatter subset skills use:
 * `key: value`, quoted values, `key: [a, b]`, block lists (`- item`), folded
 * (`>`) / literal (`|`) blocks, and `#` comments.
 */
export function parseFrontmatter(src: string): { data: Record<string, string | string[]>; body: string } | null {
  const text = src.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (!text.startsWith('---\n')) return null;
  const end = text.indexOf('\n---', 4);
  if (end < 0) return null;
  const head = text.slice(4, end);
  const afterFence = text.slice(end + 4);
  const body = afterFence.replace(/^[^\n]*\n?/, ''); // rest of the closing fence line
  const data: Record<string, string | string[]> = {};
  const lines = head.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    let v = m[2].replace(/\s+#.*$/, '').trim();
    if (v === '>' || v === '|' || v === '>-' || v === '|-') {
      const parts: string[] = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || !lines[i + 1].trim())) parts.push(lines[++i].trim());
      data[key] = v.startsWith('>') ? parts.filter(Boolean).join(' ') : parts.join('\n').trim();
    } else if (v === '') {
      const items: string[] = [];
      while (i + 1 < lines.length && (/^\s*-\s+/.test(lines[i + 1]) || /^\s*#/.test(lines[i + 1]) || !lines[i + 1].trim())) {
        const l = lines[++i];
        const it = /^\s*-\s+(.*)$/.exec(l);
        if (it) items.push(unquote(it[1].replace(/\s+#.*$/, '')));
      }
      data[key] = items;
    } else if (v.startsWith('[') && v.endsWith(']')) {
      data[key] = v
        .slice(1, -1)
        .split(',')
        .map((x) => unquote(x))
        .filter(Boolean);
    } else {
      v = m[2].trim();
      data[key] = /^["']/.test(v) ? unquote(v) : unquote(v.replace(/\s+#.*$/, ''));
    }
  }
  return { data, body };
}

const asList = (v: string | string[] | undefined): string[] => (v == null ? [] : Array.isArray(v) ? v : [v]).map((x) => String(x).trim()).filter(Boolean);

/** Parse and validate a SKILL.md. Friendly messages, for Settings → Skills. */
export function parseSkill(src: string, opts: { folderName?: string; knownTools?: readonly string[] } = {}): ParsedSkill {
  const errors: string[] = [];
  const warnings: string[] = [];
  const fm = parseFrontmatter(src);
  if (!fm) return { meta: null, body: '', errors: ['SKILL.md must start with a "---" line, then name: and description:, then another "---" line.'], warnings };
  const d = fm.data;
  for (const k of Object.keys(d)) if (!KNOWN_KEYS.includes(k)) warnings.push(`Unknown field "${k}" is ignored.`);
  const name = typeof d.name === 'string' ? d.name.trim() : '';
  if (!name) errors.push('Missing "name:" (for example: name: morning-briefing).');
  else if (!SKILL_NAME_RE.test(name)) errors.push(`The name "${name.slice(0, 60)}" should be 2–48 lowercase letters, numbers or dashes (for example: quick-note).`);
  else if (opts.folderName && opts.folderName.toLowerCase() !== name) warnings.push(`The folder is called "${opts.folderName}" but the skill's name is "${name}". Cadabra uses the name.`);
  const description = typeof d.description === 'string' ? d.description.trim() : '';
  if (!description) errors.push('Missing "description:" — one or two sentences saying when to use this skill.');
  else if (description.length < 10) errors.push('The description is too short: say when the skill should be used.');
  else if (description.length > 500) errors.push('The description is too long (500 characters at most). Put details in the instructions below the "---" line.');
  const examples = asList(d.examples);
  if (examples.length > 20) warnings.push('Only the first 20 examples are used.');
  const longEx = examples.filter((e) => e.length > 120);
  if (longEx.length) warnings.push('Examples longer than 120 characters are ignored.');
  const voice = typeof d.voice === 'string' ? d.voice.trim() : undefined;
  if (voice && voice.length > 200) warnings.push('"voice:" is longer than 200 characters; only the start is used.');
  const requires = asList(d.requires);
  if (opts.knownTools) for (const r of requires) if (!opts.knownTools.includes(r)) warnings.push(`"requires" mentions "${r.slice(0, 40)}", which isn't one of Cadabra's tools.`);
  const body = fm.body.trim();
  if (!body) errors.push('The instructions (below the second "---" line) are empty.');
  if (errors.length) return { meta: null, body, errors, warnings };
  return {
    meta: { name, description, examples: examples.filter((e) => e.length <= 120).slice(0, 20), voice: voice?.slice(0, 200), requires },
    body,
    errors,
    warnings,
  };
}

/** Text that is valid UTF-8 and not binary. */
export function decodeSkillText(buf: Uint8Array): string | null {
  if (buf.includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return null;
  }
}

const STOP = new Set(['a', 'an', 'the', 'my', 'me', 'please', 'can', 'you', 'could', 'would', 'to', 'for', 'and', 'of', 'i', 'it', 'is', 'do', 'what', 'whats', "what's", 'some', 'just', 'now', 'hey', 'ok', 'okay']);
const words = (t: string) =>
  t
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
const content = (t: string) => words(t).filter((w) => !STOP.has(w));

/**
 * The local fast path: does the utterance closely match one of a skill's
 * `examples`? Conservative on purpose: the whole example (ignoring filler
 * words) must be in what the user said, and what they said may add at most a
 * few words. Returns the single best skill, or null on no match or a tie.
 */
export function matchSkill<T extends { name: string; examples: string[] }>(utterance: string, skills: readonly T[], wakeWord = 'cadabra'): T | null {
  const said = normalizeUtterance(utterance, wakeWord);
  const saidWords = content(said);
  if (!saidWords.length) return null;
  let best: { s: T; score: number } | null = null;
  let tie = false;
  for (const s of skills) {
    for (const ex of s.examples) {
      const exWords = content(ex);
      if (!exWords.length) continue;
      let score = 0;
      if (words(ex).join(' ') === words(said).join(' ')) score = 1;
      else if (exWords.every((w) => saidWords.includes(w)) && saidWords.length <= exWords.length + 3) score = 0.8 + 0.1 * (exWords.length / saidWords.length);
      if (!score) continue;
      if (!best || score > best.score) {
        best = { s, score };
        tie = false;
      } else if (best.s !== s && Math.abs(best.score - score) < 1e-9) tie = true;
    }
  }
  return best && !tie ? best.s : null;
}
