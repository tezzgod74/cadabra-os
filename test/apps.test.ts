import { describe, expect, it } from 'vitest';
import {
  appPathsEntries,
  gogEntries,
  isConfident,
  matchApps,
  parseEpicManifest,
  parseLaunchIntent,
  parseSteamManifest,
  parseVdf,
  startAppsEntries,
  steamLibraryPaths,
  type AppEntry,
} from '../src/shared/apps';

const LIBRARYFOLDERS = `"libraryfolders"
{
	"0"
	{
		"path"		"C:\\\\Program Files (x86)\\\\Steam"
		"label"		""
		"apps"
		{
			"228980"		"201234"
			"1245620"		"58000000000"
		}
	}
	"1"
	{
		"path"		"D:\\\\SteamLibrary"
	}
}`;

const LEGACY_LIBRARYFOLDERS = `"LibraryFolders"
{
	"TimeNextStatsReport"		"1690000000"
	"ContentStatsID"		"-123"
	"1"		"E:\\\\Games\\\\Steam"
}`;

const ELDEN_ACF = `"AppState"
{
	"appid"		"1245620"
	"Universe"		"1"
	"name"		"ELDEN RING"
	"StateFlags"		"4"
	"installdir"		"ELDEN RING"
	// a comment
	"UserConfig"
	{
		"language"		"english"
	}
}`;

const REDIST_ACF = `"AppState" { "appid" "228980" "name" "Steamworks Common Redistributables" }`;

const EPIC_ITEM = JSON.stringify({
  FormatVersion: 0,
  bIsApplication: true,
  DisplayName: 'Fortnite',
  AppName: 'Fortnite',
  CatalogNamespace: 'fn',
  CatalogItemId: '4fe75bbc5a674f4f9b356b5c90567da5',
  InstallLocation: 'C:\\Program Files\\Epic Games\\Fortnite',
  LaunchExecutable: 'FortniteGame/Binaries/Win64/FortniteLauncher.exe',
});

describe('Steam parsers', () => {
  it('parses VDF with escapes and comments', () => {
    const v = parseVdf(ELDEN_ACF);
    expect(v.AppState.name).toBe('ELDEN RING');
    expect(v.AppState.UserConfig.language).toBe('english');
  });
  it('reads library folders (new + legacy formats)', () => {
    expect(steamLibraryPaths(LIBRARYFOLDERS)).toEqual(['C:\\Program Files (x86)\\Steam', 'D:\\SteamLibrary']);
    expect(steamLibraryPaths(LEGACY_LIBRARYFOLDERS)).toEqual(['E:\\Games\\Steam']);
  });
  it('turns an appmanifest into a steam://rungameid entry', () => {
    expect(parseSteamManifest(ELDEN_ACF)).toEqual({ id: 'steam:1245620', name: 'ELDEN RING', source: 'steam', target: 'steam://rungameid/1245620', kind: 'uri', aliases: [] });
  });
  it('skips redistributables and junk', () => {
    expect(parseSteamManifest(REDIST_ACF)).toBeNull();
    expect(parseSteamManifest('garbage')).toBeNull();
  });
});

describe('Epic parser', () => {
  it('builds the launcher URI and exe path', () => {
    const e = parseEpicManifest(EPIC_ITEM)!;
    expect(e.id).toBe('epic:Fortnite');
    expect(e.target).toBe('com.epicgames.launcher://apps/fn%3A4fe75bbc5a674f4f9b356b5c90567da5%3AFortnite?action=launch&silent=true');
    expect(e.exe).toBe('C:\\Program Files\\Epic Games\\Fortnite\\FortniteGame\\Binaries\\Win64\\FortniteLauncher.exe');
  });
  it('falls back to AppName-only URIs and rejects junk', () => {
    expect(parseEpicManifest(JSON.stringify({ DisplayName: 'X', AppName: 'Xa' }))!.target).toBe('com.epicgames.launcher://apps/Xa?action=launch&silent=true');
    expect(parseEpicManifest('{not json')).toBeNull();
    expect(parseEpicManifest(JSON.stringify({ DisplayName: 'Unreal Engine', AppName: 'UE_5.4', bIsApplication: true }))).toBeNull();
  });
});

describe('registry / Get-StartApps parsers', () => {
  const REG = `
HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe
    (Default)    REG_SZ    C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe
    Path    REG_SZ    C:\\Program Files\\Google\\Chrome\\Application

HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Empty.exe

`;
  it('reads App Paths', () => {
    const e = appPathsEntries(REG);
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ id: 'apppaths:chrome', name: 'chrome', target: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', kind: 'path' });
  });
  it('reads GOG games', () => {
    const g = gogEntries(`
HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\GOG.com\\Games\\1207658924
    gameID    REG_SZ    1207658924
    gameName    REG_SZ    The Witcher 3: Wild Hunt
    exe    REG_SZ    D:\\GOG\\Witcher3\\bin\\x64\\witcher3.exe
`);
    expect(g[0]).toMatchObject({ id: 'gog:1207658924', name: 'The Witcher 3: Wild Hunt', kind: 'path' });
  });
  it('keeps only packaged apps from Get-StartApps', () => {
    const s = startAppsEntries(
      JSON.stringify([
        { Name: 'Spotify', AppID: 'SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify' },
        { Name: 'Notepad++', AppID: '{6D809377-6AF0-444B-8957-A3773F02200E}\\Notepad++\\notepad++.exe' },
      ]),
    );
    expect(s).toEqual([{ id: 'store:SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify', name: 'Spotify', source: 'store', target: 'shell:AppsFolder\\SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify', kind: 'aumid', aliases: [] }]);
    expect(startAppsEntries(JSON.stringify({ Name: 'Calc', AppID: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App' }))).toHaveLength(1);
  });
});

const app = (name: string, source: AppEntry['source'] = 'startmenu', id = `${source}:${name}`): AppEntry => ({ id, name, source, target: 'x', kind: 'path', aliases: [] });
const APPS = [
  app('Visual Studio Code'),
  app('Visual Studio 2022'),
  app('Google Chrome'),
  app('Chrome Remote Desktop'),
  app('Spotify', 'store'),
  app('Spotify', 'desktop'),
  app('ELDEN RING', 'steam'),
  app('Elder Scrolls Online', 'steam'),
  app('Roblox Player'),
  app('Roblox Studio'),
  app('Notepad'),
  app('Notepad++'),
  app('Calculator', 'store'),
  app('Microsoft Edge'),
];

describe('fuzzy app matching', () => {
  const top = (q: string, usage = {}) => matchApps(q, APPS, usage)[0]?.app.name;
  it('matches aliases and abbreviations', () => {
    expect(top('vs code')).toBe('Visual Studio Code');
    expect(top('code')).toBe('Visual Studio Code');
    expect(top('chrome')).toBe('Google Chrome');
    expect(top('edge')).toBe('Microsoft Edge');
    expect(top('calc')).toBe('Calculator');
  });
  it('matches partial names and possessives', () => {
    expect(top('elden')).toBe('ELDEN RING');
    expect(top('my roblox')).toBe('Roblox Player');
    expect(top('Elden Ring')).toBe('ELDEN RING');
  });
  it('tolerates typos', () => {
    expect(top('spotfy')).toBe('Spotify');
    expect(top('calculater')).toBe('Calculator');
  });
  it('dedupes the same app from several sources (prefers the store/start-menu entry)', () => {
    const ms = matchApps('spotify', APPS);
    expect(ms.filter((m) => m.app.name === 'Spotify')).toHaveLength(1);
    expect(ms[0].app.source).toBe('store');
  });
  it('flags ambiguity, and usage frequency breaks ties', () => {
    const ms = matchApps('notepad', APPS);
    expect(ms[0].app.name).toBe('Notepad');
    expect(isConfident(ms)).toBe(true);
    const vs = matchApps('visual studio', APPS);
    expect(isConfident(vs)).toBe(false);
    const vs2 = matchApps('visual studio', APPS, { 'startmenu:Visual Studio 2022': 20 });
    expect(vs2[0].app.name).toBe('Visual Studio 2022');
  });
  it('prefers real shortcuts over bare App Paths exe names', () => {
    const ms = matchApps('chrome', [...APPS, { ...app('chrome', 'apppaths') }]);
    expect(ms[0].app.name).toBe('Google Chrome');
    expect(isConfident(ms)).toBe(true);
  });
  it('returns nothing for unrelated queries', () => {
    expect(matchApps('photoshop', APPS)).toEqual([]);
  });
});

describe('parseLaunchIntent', () => {
  it('extracts the app', () => {
    expect(parseLaunchIntent('Cadabra, open Spotify')).toBe('spotify');
    expect(parseLaunchIntent('launch Elden Ring')).toBe('elden ring');
    expect(parseLaunchIntent('start my roblox')).toBe('my roblox');
    expect(parseLaunchIntent('can you open vs code please')).toBe('vs code');
    expect(parseLaunchIntent('open file explorer')).toBe('file explorer');
  });
  it('ignores in-app actions and non-launch requests', () => {
    expect(parseLaunchIntent('open the file menu')).toBeNull();
    expect(parseLaunchIntent('open a new tab')).toBeNull();
    expect(parseLaunchIntent('what is this error')).toBeNull();
  });
});

describe('O3: launch intent never swallows multi-step requests', () => {
  it('sends "open X and do Y" to the AI', () => {
    expect(parseLaunchIntent('open terminal and ping google')).toBeNull();
    expect(parseLaunchIntent('open notepad then type hello')).toBeNull();
    expect(parseLaunchIntent('open spotify, play jazz')).toBeNull();
    expect(parseLaunchIntent('open chrome to search cats')).toBeNull();
    expect(parseLaunchIntent('open spotify play some jazz')).toBeNull();
  });
  it('still launches plain app names', () => {
    expect(parseLaunchIntent('open microsoft to do')).toBe('microsoft to do');
    expect(parseLaunchIntent('open call of duty')).toBe('call of duty');
    expect(parseLaunchIntent('open spotify, please')).toBe('spotify');
    expect(parseLaunchIntent('launch command and conquer')).toBe('command and conquer');
  });
});
