// UX6: real app icons (pure parts; the Electron extraction is exercised by `npm run apptest`).
import { describe, expect, it } from 'vitest';
import { appxLogoFromManifest, expandEnv, iconCandidates, pickAppxAsset } from '../src/shared/apps';

describe('app icons', () => {
  it('expands env vars and orders icon candidates', () => {
    const env = { ProgramFiles: 'C:\\Program Files', SystemRoot: 'C:\\Windows' };
    expect(expandEnv('%programfiles%\\App\\a.exe', env)).toBe('C:\\Program Files\\App\\a.exe');
    expect(
      iconCandidates({ iconPath: '%SystemRoot%\\system32\\shell32.dll,-21', exe: 'C:\\x\\app.exe', target: 'C:\\s\\App.lnk', kind: 'path' }, env),
    ).toEqual(['C:\\Windows\\system32\\shell32.dll', 'C:\\x\\app.exe', 'C:\\s\\App.lnk']);
    // An unexpandable variable is skipped rather than passed to getFileIcon.
    expect(iconCandidates({ iconPath: '%NOPE%\\a.ico', target: 'C:\\s\\A.lnk', kind: 'path' }, env)).toEqual(['C:\\s\\A.lnk']);
  });

  it('reads the tile logo from an AppX manifest', () => {
    const xml = `<Package><Properties><Logo>Assets\\StoreLogo.png</Logo></Properties><Applications>
      <Application Id="App" Executable="Calc.exe"><uap:VisualElements DisplayName="Calculator" Square150x150Logo="Assets\\Med.png" Square44x44Logo="Assets\\CalculatorAppList.png" /></Application>
      <Application Id="Other"><uap:VisualElements Square44x44Logo="Assets\\Other.png" /></Application></Applications></Package>`;
    expect(appxLogoFromManifest(xml, 'App')).toBe('Assets\\CalculatorAppList.png');
    expect(appxLogoFromManifest(xml, 'Other')).toBe('Assets\\Other.png');
    expect(appxLogoFromManifest('<Package><Logo>a.png</Logo></Package>', 'App')).toBe('a.png');
  });

  it('picks the best scale/targetsize variant', () => {
    const files = ['CalculatorAppList.scale-100.png', 'CalculatorAppList.scale-200.png', 'CalculatorAppList.targetsize-48_altform-unplated.png', 'Other.png'];
    expect(pickAppxAsset('Assets\\CalculatorAppList.png', files)).toBe('CalculatorAppList.targetsize-48_altform-unplated.png');
    expect(pickAppxAsset('Assets\\CalculatorAppList.png', files.slice(0, 2))).toBe('CalculatorAppList.scale-200.png');
    expect(pickAppxAsset('Assets/Other.png', files)).toBe('Other.png');
    expect(pickAppxAsset('Assets/Missing.png', files)).toBeUndefined();
  });
});
