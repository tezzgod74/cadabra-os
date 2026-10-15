// App index model + pure parsers (Steam VDF/ACF, Epic manifests, reg.exe
// output, Get-StartApps JSON) + the fuzzy matcher. No I/O here: everything is
// unit-tested with fixtures (test/apps.test.ts).

export type AppSource = 'startmenu' | 'desktop' | 'store' | 'steam' | 'epic' | 'gog' | 'apppaths';

export interface AppEntry {
  /** Stable id: `${source}:${key}` */
  id: string;
  name: string;
  source: AppSource;
  /** What to launch: a .lnk/.exe path, a protocol URI, or `shell:AppsFolder\<AUMID>`. */
  target: string;
  kind: 'path' | 'uri' | 'aumid';
  /** Executable the app runs (when known) — used to find an already-running window. */
  exe?: string;
  /** Extra names it answers to. */
  aliases: string[];
  /** File to extract the icon from (when known). */
  iconPath?: string;
}

// ------------------------------------------------------------------ VDF ----

/** Minimal Valve KeyValues (VDF/ACF) parser: nested objects of strings. */
export function parseVdf(text: string): Record<string, any> {
  const tokens: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|([{}])|\/\/[^\n]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m[1] !== undefined) tokens.push(m[1].replace(/\\\\/g, '\\').replace(/\\"/g, '"'));
    else if (m[2]) tokens.push(m[2]);
  }
  let i = 0;
  const obj = (): Record<string, any> => {
    const out: Record<string, any> = {};
    while (i < tokens.length) {
      const k = tokens[i++];
      if (k === '}') return out;
      const v = tokens[i++];
      if (v === '{') out[k] = obj();
      else out[k] = v;
    }
    return out;
  };
  return obj();
}

/** Library folders from steamapps/libraryfolders.vdf (new and legacy formats). */
export function steamLibraryPaths(vdfText: string): string[] {
  const root = parseVdf(vdfText);
  const lf = root.libraryfolders ?? root.LibraryFolders ?? {};
  const out: string[] = [];
  for (const [k, v] of Object.entries(lf)) {
    if (!/^\d+$/.test(k)) continue;
    if (typeof v === 'string') out.push(v);
    else if (v && typeof (v as any).path === 'string') out.push((v as any).path);
  }
  return out;
}

/** Steam redistributables / tools that aren't games. */
const STEAM_NON_GAMES = new Set(['228980', '1070560', '1391110', '1493710', '1628350', '2180100']);

export function parseSteamManifest(acfText: string): AppEntry | null {
  const st = parseVdf(acfText).AppState;
  if (!st?.appid || !st?.name) return null;
  if (STEAM_NON_GAMES.has(String(st.appid)) || /redistributable|steamworks common|proton|steam linux runtime/i.test(st.name)) return null;
  return {
    id: `steam:${st.appid}`,
    name: String(st.name),
    source: 'steam',
    target: `steam://rungameid/${st.appid}`,
    kind: 'uri',
    aliases: [],
  };
}

// ----------------------------------------------------------------- Epic ----

export function parseEpicManifest(jsonText: string): AppEntry | null {
  let j: any;
  try {
    j = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (!j?.DisplayName || !j?.AppName) return null;
  if (j.bIsApplication === false || /^UE_\d/.test(j.AppName)) return null; // engine installs / DLC
  const ns = j.CatalogNamespace ?? j.MainGameCatalogNamespace;
  const item = j.CatalogItemId ?? j.MainGameCatalogItemId;
  const appRef = ns && item ? `${ns}%3A${item}%3A${j.AppName}` : j.AppName;
  const exe = j.InstallLocation && j.LaunchExecutable ? `${String(j.InstallLocation).replace(/[\\/]+$/, '')}\\${String(j.LaunchExecutable).replace(/\//g, '\\')}` : undefined;
  return {
    id: `epic:${j.AppName}`,
    name: String(j.DisplayName),
    source: 'epic',
    target: `com.epicgames.launcher://apps/${appRef}?action=launch&silent=true`,
    kind: 'uri',
    exe,
    iconPath: exe,
    aliases: [],
  };
}

// ------------------------------------------------------------ registry ----

/** Parse `reg query <key> /s` output into { keyPath: { valueName: data } }. */
export function parseRegQuery(out: string): Record<string, Record<string, string>> {
  const res: Record<string, Record<string, string>> = {};
  let cur: Record<string, string> | null = null;
  for (const raw of out.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    if (/^HKEY_/.test(raw)) {
      cur = res[raw.trim()] = {};
      continue;
    }
    const m = /^\s{2,}(.*?)\s{4}(REG_[A-Z_]+)\s{4}?(.*)$/.exec(raw);
    if (m && cur) cur[m[1] === '(Default)' ? '' : m[1]] = m[3] ?? '';
  }
  return res;
}

export function appPathsEntries(regOut: string): AppEntry[] {
  const out: AppEntry[] = [];
  for (const [key, vals] of Object.entries(parseRegQuery(regOut))) {
    const exeName = key.split('\\').pop() ?? '';
    if (!/\.exe$/i.test(exeName)) continue;
    const target = (vals[''] ?? '').replace(/^"|"$/g, '').trim();
    if (!target) continue;
    const base = exeName.replace(/\.exe$/i, '');
    out.push({
      id: `apppaths:${base.toLowerCase()}`,
      name: base,
      source: 'apppaths',
      target,
      kind: 'path',
      exe: target,
      iconPath: target,
      aliases: [base.toLowerCase()],
    });
  }
  return out;
}

export function gogEntries(regOut: string): AppEntry[] {
  const out: AppEntry[] = [];
  for (const vals of Object.values(parseRegQuery(regOut))) {
    const name = vals.gameName ?? vals.GAMENAME;
    const exe = vals.exe ?? vals.EXE;
    const id = vals.gameID ?? vals.GAMEID;
    if (!name || !exe || !id) continue;
    out.push({ id: `gog:${id}`, name, source: 'gog', target: exe, kind: 'path', exe, iconPath: exe, aliases: [] });
  }
  return out;
}

/** `Get-StartApps | ConvertTo-Json` output → Store/UWP (and other AUMID) apps. */
export function startAppsEntries(json: string): AppEntry[] {
  let arr: any;
  try {
    arr = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) arr = arr ? [arr] : [];
  const out: AppEntry[] = [];
  for (const a of arr) {
    const name = a?.Name;
    const aumid = a?.AppID;
    // Only packaged apps ("Publisher.App_hash!App"); classic apps come from shortcuts.
    if (!name || !aumid || !/!/.test(aumid)) continue;
    out.push({ id: `store:${aumid}`, name, source: 'store', target: `shell:AppsFolder\\${aumid}`, kind: 'aumid', aliases: [] });
  }
  return out;
}

// ------------------------------------------------------------- matching ----

const KNOWN_ALIASES: Record<string, string[]> = {
  'visual studio code': ['vs code', 'vscode', 'code'],
  'google chrome': ['chrome'],
  'microsoft edge': ['edge'],
  'mozilla firefox': ['firefox'],
  'microsoft teams': ['teams'],
  'file explorer': ['explorer', 'files'],
  'windows terminal': ['terminal'],
  'command prompt': ['cmd'],
  'windows powershell': ['powershell'],
  calculator: ['calc'],
  notepad: ['notes app', 'text editor'],
  'snipping tool': ['snip', 'screenshot tool'],
  settings: ['windows settings', 'control panel'],
  'microsoft store': ['store', 'app store'],
  'adobe photoshop': ['photoshop', 'ps'],
  'obs studio': ['obs'],
  'microsoft outlook': ['outlook', 'mail'],
  outlook: ['mail', 'email'],
  'microsoft word': ['word'],
  'microsoft excel': ['excel'],
  'microsoft powerpoint': ['powerpoint', 'ppt'],
  'roblox player': ['roblox'],
  'epic games launcher': ['epic', 'epic games'],
  'battle.net': ['battlenet', 'blizzard'],
};

const NOISE_WORDS = /\b(the|my|app|application|program|game)\b/g;

export function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[™®©]/g, '')
    .replace(/\(.*?\)/g, ' ')
    .replace(/[^a-z0-9.+# ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function acronym(name: string): string {
  return normalizeName(name)
    .split(' ')
    .filter(Boolean)
    .map((w) => w[0])
    .join('');
}

export function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

export function aliasesFor(name: string): string[] {
  const n = normalizeName(name);
  const out = new Set<string>(KNOWN_ALIASES[n] ?? []);
  const ac = acronym(name);
  if (ac.length >= 2 && n.includes(' ')) out.add(ac);
  return [...out];
}

export interface Match {
  app: AppEntry;
  score: number;
}

function scoreOne(q: string, app: AppEntry): number {
  const name = normalizeName(app.name);
  const aliases = [...app.aliases, ...aliasesFor(app.name)].map(normalizeName);
  if (!q) return 0;
  if (name === q) return 100;
  if (aliases.includes(q)) return 95;
  if (name.startsWith(q + ' ') || name.startsWith(q)) return 85 - Math.min(10, (name.length - q.length) / 4);
  const nameTokens = name.split(' ');
  const qTokens = q.split(' ');
  if (qTokens.every((t) => nameTokens.some((n) => n.startsWith(t)))) return 78;
  if (aliases.some((a) => a.startsWith(q))) return 74;
  if (q.length >= 3 && name.includes(q)) return 65;
  // Typos: compare against the name and its first token.
  const d = Math.min(editDistance(q, name), editDistance(q, nameTokens[0]), ...aliases.map((a) => editDistance(q, a)));
  const tol = q.length <= 4 ? 1 : q.length <= 8 ? 2 : 3;
  if (d <= tol) return 60 - d * 6;
  return 0;
}

/** Rank apps for a query; `usage` maps app id → launch count (frequency boost). */
export function matchApps(query: string, apps: AppEntry[], usage: Record<string, number> = {}, limit = 5): Match[] {
  const q = normalizeName(query).replace(NOISE_WORDS, ' ').replace(/\s+/g, ' ').trim();
  const best = new Map<string, Match>(); // dedupe same app from several sources by normalized name
  const sourceRank: Record<AppSource, number> = { store: 0, startmenu: 1, steam: 2, epic: 2, gog: 2, desktop: 3, apppaths: 4 };
  for (const app of apps) {
    let s = scoreOne(q, app);
    if (s <= 0) continue;
    s += Math.min(8, Math.log2(1 + (usage[app.id] ?? 0)) * 3);
    // App Paths entries are bare exe names ("chrome"); prefer the real shortcut ("Google Chrome").
    if (app.source === 'apppaths') s -= 8;
    const key = normalizeName(app.name);
    const prev = best.get(key);
    if (!prev || s > prev.score || (s === prev.score && sourceRank[app.source] < sourceRank[prev.app.source])) best.set(key, { app, score: s });
  }
  return [...best.values()].sort((a, b) => b.score - a.score || a.app.name.length - b.app.name.length).slice(0, limit);
}

/** Is the top match clearly the one the user meant? */
export function isConfident(ms: Match[]): boolean {
  if (!ms.length) return false;
  if (ms[0].score >= 95 && (ms.length < 2 || ms[1].score < 95)) return true;
  return ms[0].score >= 70 && (ms.length < 2 || ms[0].score - ms[1].score >= 10);
}

/** "open spotify", "launch elden ring", "start my roblox" → "spotify" ... */
const FOLLOW_VERBS = 'do|type|search|ping|nslookup|run|go|show|find|check|look|tell|write|open|play|make|create|send|close|start|navigate|copy|paste|read|save|print|call|join|watch|listen';

export function parseLaunchIntent(text: string): string | null {
  const t = text
    .toLowerCase()
    .replace(/^(hey |ok |okay )?(c|k)a+ ?d+[aeiou]*b+[aeiou]*r+[aeiou]*h?[\s,.!?:;-]*/, '')
    .replace(/[.!?]+$/, '')
    .trim();
  const m = /^(?:please |can you |could you )?(?:open|launch|start|run|fire up|boot up|load)(?: up)? (.+?)(?: for me| please| now)?$/.exec(t);
  if (!m) return null;
  const what = m[1].trim();
  // "open the file menu", "open a new tab" are UI actions, not apps.
  if (/\b(menu|tab|window|file|folder|link|settings page|dialog|chat|message|email|document)\b/.test(what) && !/^(file explorer|settings)$/.test(what)) return null;
  if (what.split(' ').length > 5) return null;
  // O3: multi-step requests ("open terminal and ping google", "open notepad then type hi")
  // go to the AI, not the launcher.
  if (/\b(then|after that|afterwards)\b|\w[,;]\s*\w/.test(what)) return null;
  if (/\bto do\b/.test(what)) return what.replace(/[,;]+$/, ''); // Microsoft To Do
  if (new RegExp(`\\b(and|to|so|&)\\s+(?:${FOLLOW_VERBS})\\b`).test(what)) return null;
  if (new RegExp(`\\s(?:${FOLLOW_VERBS})\\s+\\S`).test(what)) return null;
  return what.replace(/[,;]+$/, '');
}

// ------------------------------------------------------------------ icons ----
// UX6: real app icons instead of letter avatars.

/** Expand %VAR% references (case-insensitive) using `env`. */
export function expandEnv(p: string, env: Record<string, string | undefined>): string {
  const lower = Object.fromEntries(Object.entries(env).map(([k, v]) => [k.toLowerCase(), v]));
  return p.replace(/%([^%]+)%/g, (m, k: string) => lower[k.toLowerCase()] ?? m);
}

/** Files to try for an entry's icon, best first (icon resource, exe, then the shortcut itself). */
export function iconCandidates(a: Pick<AppEntry, 'iconPath' | 'exe' | 'target' | 'kind'>, env: Record<string, string | undefined>): string[] {
  const out: string[] = [];
  const add = (p?: string) => {
    if (!p) return;
    const clean = expandEnv(p.trim().replace(/^"|"$/g, ''), env).replace(/,\s*-?\d+$/, '');
    if (clean && !/%/.test(clean) && !out.includes(clean)) out.push(clean);
  };
  if (a.iconPath && /\.(exe|ico|dll)$/i.test(a.iconPath.replace(/,\s*-?\d+$/, ''))) add(a.iconPath);
  add(a.exe);
  if (a.kind === 'path') add(a.target);
  add(a.iconPath);
  return out;
}

/** The tile logo an AppX manifest declares for application `appId` (relative path). */
export function appxLogoFromManifest(xml: string, appId: string): string | undefined {
  const apps = [...xml.matchAll(/<Application\b[^>]*\bId="([^"]+)"[^>]*>([\s\S]*?)<\/Application>/g)];
  const app = apps.find((m) => m[1] === appId) ?? apps[0];
  const ve = app?.[2] ?? '';
  const attr = (name: string) => new RegExp(`\\b${name}="([^"]+)"`).exec(ve)?.[1];
  return attr('Square44x44Logo') ?? attr('Square150x150Logo') ?? /<Logo>([^<]+)<\/Logo>/.exec(xml)?.[1];
}

/**
 * AppX assets ship as scale/targetsize variants ("Logo.targetsize-48_altform-unplated.png",
 * "Logo.scale-200.png"); pick the best one that exists in `files` (names in the asset dir).
 */
export function pickAppxAsset(rel: string, files: string[]): string | undefined {
  const base = rel.replace(/\\/g, '/').split('/').pop()!;
  const dot = base.lastIndexOf('.');
  const stem = (dot > 0 ? base.slice(0, dot) : base).toLowerCase();
  const ext = (dot > 0 ? base.slice(dot) : '.png').toLowerCase();
  const lower = new Map(files.map((f) => [f.toLowerCase(), f]));
  const prefs = [
    `${stem}.targetsize-48_altform-unplated${ext}`,
    `${stem}.targetsize-64_altform-unplated${ext}`,
    `${stem}.targetsize-48_altform-lightunplated${ext}`,
    `${stem}.targetsize-48${ext}`,
    `${stem}.targetsize-64${ext}`,
    `${stem}.scale-200${ext}`,
    `${stem}.scale-150${ext}`,
    `${stem}.scale-100${ext}`,
    `${stem}${ext}`,
  ];
  for (const p of prefs) if (lower.has(p)) return lower.get(p);
  return files.find((f) => f.toLowerCase().startsWith(`${stem}.`) && f.toLowerCase().endsWith(ext));
}
