// UX6: real icons for the launcher. Classic apps: the shortcut's icon
// resource / target exe via app.getFileIcon. Store (AppX) apps: the tile logo
// from the package's AppxManifest.xml.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { app, nativeImage } from 'electron';
import { appxLogoFromManifest, iconCandidates, pickAppxAsset, type AppEntry } from '../../shared/apps';

let appxDirs: Promise<Map<string, string>> | null = null;

/** PackageFamilyName -> InstallLocation for every installed package (one PowerShell call, cached). */
function appxInstallDirs(): Promise<Map<string, string>> {
  appxDirs ??= new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-AppxPackage | ForEach-Object { "$($_.PackageFamilyName)`t$($_.InstallLocation)" }'],
      { windowsHide: true, timeout: 20000, maxBuffer: 8 * 1024 * 1024 },
      (_e, stdout) => {
        const m = new Map<string, string>();
        for (const line of String(stdout ?? '').split(/\r?\n/)) {
          const [pfn, dir] = line.split('\t');
          if (pfn && dir) m.set(pfn.trim().toLowerCase(), dir.trim());
        }
        resolve(m);
      },
    );
  });
  return appxDirs;
}

async function appxIcon(aumid: string): Promise<string | null> {
  const [pfn, appId] = aumid.split('!');
  const dir = (await appxInstallDirs()).get(pfn.toLowerCase());
  if (!dir) return null;
  try {
    const xml = fs.readFileSync(path.join(dir, 'AppxManifest.xml'), 'utf8');
    const rel = appxLogoFromManifest(xml, appId ?? '');
    if (!rel) return null;
    const assetDir = path.join(dir, path.dirname(rel.replace(/\\/g, '/')));
    const file = pickAppxAsset(rel, fs.readdirSync(assetDir));
    if (!file) return null;
    const img = nativeImage.createFromPath(path.join(assetDir, file));
    return img.isEmpty() ? null : img.resize({ width: 64, height: 64, quality: 'best' }).toDataURL();
  } catch {
    return null;
  }
}

/** A data: URL for the app's icon, or null (the panel then shows a letter avatar). */
export async function resolveAppIcon(a: AppEntry): Promise<string | null> {
  if (a.kind === 'aumid') return appxIcon(a.target.replace(/^shell:AppsFolder\\/i, ''));
  for (const file of iconCandidates(a, process.env)) {
    if (!fs.existsSync(file)) continue;
    try {
      const img = await app.getFileIcon(file, { size: 'large' });
      if (!img.isEmpty()) return img.toDataURL();
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}
