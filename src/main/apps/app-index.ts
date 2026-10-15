import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  aliasesFor,
  appPathsEntries,
  gogEntries,
  matchApps,
  parseEpicManifest,
  parseSteamManifest,
  parseRegQuery,
  startAppsEntries,
  steamLibraryPaths,
  type AppEntry,
  type AppSource,
  type Match,
} from '../../shared/apps';

export interface ShortcutReader {
  readShortcutLink(p: string): { target: string; args?: string; icon?: string };
}

const run = (file: string, args: string[], timeout = 15000) =>
  new Promise<string>((resolve) => {
    execFile(file, args, { windowsHide: true, timeout, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' }, (err, stdout) => resolve(err && !stdout ? '' : String(stdout)));
  });

const SKIP_SHORTCUT = /\b(uninstall|uninstaller|readme|read me|help|documentation|manual|website|web site|release notes|license|changelog|support|faq|what'?s new|repair)\b/i;

function walk(dir: string, exts: RegExp, depth = 0, out: string[] = []): string[] {
  if (depth > 5) return out;
  let ents: fs.Dirent[];
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, exts, depth + 1, out);
    else if (exts.test(e.name)) out.push(p);
  }
  return out;
}

/**
 * Background-built index of everything launchable: Start Menu + Desktop
 * shortcuts, Store/UWP apps (Get-StartApps), Steam, Epic, GOG and App Paths.
 * Cached as JSON in userData; refreshed on startup, periodically and on demand.
 */
export class AppIndex {
  apps: AppEntry[] = [];
  builtAt = 0;
  counts: Partial<Record<AppSource, number>> = {};
  private usage: Record<string, number> = {};
  private building: Promise<void> | null = null;
  private readonly cacheFile: string;
  private readonly usageFile: string;

  constructor(
    dir: string,
    private readonly sc: ShortcutReader | null,
  ) {
    fs.mkdirSync(dir, { recursive: true });
    this.cacheFile = path.join(dir, 'app-index.json');
    this.usageFile = path.join(dir, 'app-usage.json');
    try {
      const c = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
      if (Array.isArray(c.apps)) {
        this.apps = c.apps;
        this.builtAt = c.builtAt ?? 0;
        this.counts = c.counts ?? {};
      }
    } catch {
      /* first run */
    }
    try {
      this.usage = JSON.parse(fs.readFileSync(this.usageFile, 'utf8'));
    } catch {
      this.usage = {};
    }
  }

  get stale(): boolean {
    return Date.now() - this.builtAt > 6 * 3600_000;
  }

  refresh(): Promise<void> {
    if (!this.building) this.building = this.build().finally(() => (this.building = null));
    return this.building;
  }

  async ready(): Promise<void> {
    if (!this.apps.length) await this.refresh();
  }

  find(query: string, limit = 5): Match[] {
    return matchApps(query, this.apps, this.usage, limit);
  }

  get(id: string): AppEntry | undefined {
    return this.apps.find((a) => a.id === id);
  }

  recordLaunch(id: string) {
    this.usage[id] = (this.usage[id] ?? 0) + 1;
    try {
      fs.writeFileSync(this.usageFile, JSON.stringify(this.usage));
    } catch {
      /* ignore */
    }
  }

  private async build() {
    const results = await Promise.all([
      this.startMenu().catch(() => []),
      this.desktop().catch(() => []),
      this.store().catch(() => []),
      this.steam().catch(() => []),
      this.epic().catch(() => []),
      this.gog().catch(() => []),
      this.appPaths().catch(() => []),
    ]);
    const byId = new Map<string, AppEntry>();
    for (const list of results) for (const a of list) if (!byId.has(a.id)) byId.set(a.id, { ...a, aliases: a.aliases.length ? a.aliases : aliasesFor(a.name) });
    this.apps = [...byId.values()];
    this.builtAt = Date.now();
    this.counts = {};
    for (const a of this.apps) this.counts[a.source] = (this.counts[a.source] ?? 0) + 1;
    try {
      fs.writeFileSync(this.cacheFile, JSON.stringify({ builtAt: this.builtAt, counts: this.counts, apps: this.apps }));
    } catch {
      /* ignore */
    }
  }

  private shortcutEntries(files: string[], source: 'startmenu' | 'desktop', root: string): AppEntry[] {
    const out: AppEntry[] = [];
    for (const f of files) {
      const name = path.basename(f).replace(/\.(lnk|url)$/i, '').trim();
      if (!name || SKIP_SHORTCUT.test(name)) continue;
      let exe: string | undefined;
      let iconPath: string | undefined;
      if (/\.lnk$/i.test(f) && this.sc) {
        try {
          const l = this.sc.readShortcutLink(f);
          if (l.target && /\.exe$/i.test(l.target)) exe = l.target;
          iconPath = l.icon || l.target || f;
          // Skip shortcuts to documents / folders / web pages.
          if (l.target && !/\.(exe|bat|cmd|msc|appref-ms)$/i.test(l.target) && fs.existsSync(l.target) && fs.statSync(l.target).isDirectory()) continue;
          if (l.target && /\.(html?|pdf|txt|chm|url)$/i.test(l.target)) continue;
        } catch {
          /* unreadable shortcut: still launchable */
        }
      } else if (/\.url$/i.test(f)) {
        try {
          const url = /^URL=(.+)$/im.exec(fs.readFileSync(f, 'utf8'))?.[1]?.trim() ?? '';
          // Game launcher shortcuts are .url files; plain web links are not apps.
          if (!/^(steam|com\.epicgames\.launcher|uplay|origin2?|battlenet|roblox[a-z-]*|goggalaxy|eadm):/i.test(url)) continue;
        } catch {
          continue;
        }
      }
      out.push({
        id: `${source}:${path.relative(root, f).toLowerCase()}`,
        name,
        source,
        target: f,
        kind: 'path',
        exe,
        iconPath: iconPath ?? f,
        aliases: [],
      });
    }
    return out;
  }

  private async startMenu(): Promise<AppEntry[]> {
    const roots = [
      path.join(process.env.ProgramData ?? 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
      path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    ];
    return roots.flatMap((r) => this.shortcutEntries(walk(r, /\.(lnk|url)$/i), 'startmenu', path.dirname(path.dirname(r))));
  }

  private async desktop(): Promise<AppEntry[]> {
    const roots = [path.join(os.homedir(), 'Desktop'), path.join(process.env.PUBLIC ?? 'C:\\Users\\Public', 'Desktop')];
    if (process.env.OneDrive) roots.push(path.join(process.env.OneDrive, 'Desktop'));
    return [...new Set(roots)].flatMap((r) => this.shortcutEntries(walk(r, /\.(lnk|url)$/i, 4), 'desktop', path.dirname(r)));
  }

  private async store(): Promise<AppEntry[]> {
    const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-StartApps | ConvertTo-Json -Compress'], 20000);
    return startAppsEntries(out.trim());
  }

  private async steam(): Promise<AppEntry[]> {
    const reg = parseRegQuery(await run('reg.exe', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath']));
    const steamPath = Object.values(reg)[0]?.SteamPath?.replace(/\//g, '\\');
    const roots = new Set<string>();
    if (steamPath) roots.add(steamPath);
    for (const p of ['C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam']) if (fs.existsSync(p)) roots.add(p);
    const libs = new Set<string>();
    for (const r of roots) {
      libs.add(r);
      try {
        for (const l of steamLibraryPaths(fs.readFileSync(path.join(r, 'steamapps', 'libraryfolders.vdf'), 'utf8'))) libs.add(l);
      } catch {
        /* none */
      }
    }
    const out: AppEntry[] = [];
    for (const lib of libs) {
      const dir = path.join(lib, 'steamapps');
      let files: string[];
      try {
        files = fs.readdirSync(dir).filter((f) => /^appmanifest_\d+\.acf$/i.test(f));
      } catch {
        continue;
      }
      for (const f of files) {
        try {
          const e = parseSteamManifest(fs.readFileSync(path.join(dir, f), 'utf8'));
          if (e) out.push(e);
        } catch {
          /* skip */
        }
      }
    }
    return out;
  }

  private async epic(): Promise<AppEntry[]> {
    const dir = path.join(process.env.ProgramData ?? 'C:\\ProgramData', 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests');
    let files: string[];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.item'));
    } catch {
      return [];
    }
    return files.map((f) => parseEpicManifest(fs.readFileSync(path.join(dir, f), 'utf8'))).filter((x): x is AppEntry => !!x);
  }

  private async gog(): Promise<AppEntry[]> {
    return gogEntries(await run('reg.exe', ['query', 'HKLM\\SOFTWARE\\WOW6432Node\\GOG.com\\Games', '/s']));
  }

  private async appPaths(): Promise<AppEntry[]> {
    const [a, b] = await Promise.all([
      run('reg.exe', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths', '/s']),
      run('reg.exe', ['query', 'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths', '/s']),
    ]);
    return [...appPathsEntries(a), ...appPathsEntries(b)].filter((e) => !/\\(windows|system32)\\/i.test(e.target) || /notepad|mspaint|wordpad/i.test(e.target));
  }
}
