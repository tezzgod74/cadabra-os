import { describe, expect, it } from 'vitest';
import { classifyAction, DEFAULT_SAFETY, findRiskyWords, matchDenyRule, checkObservation } from '../src/shared/safety';


const S = DEFAULT_SAFETY;

describe('risky word matching', () => {
  it('matches whole words only', () => {
    expect(findRiskyWords('Send', S.riskyWords)).toContain('send');
    expect(findRiskyWords('Resend code', S.riskyWords)).not.toContain('send');
    expect(findRiskyWords('Description', S.riskyWords)).toEqual([]);
    expect(findRiskyWords('Place order now', S.riskyWords)).toContain('place order');
    expect(findRiskyWords('Delete conversation', S.riskyWords)).toContain('delete');
  });
});

describe('deny rules', () => {
  it('blocks password managers by process', () => {
    expect(matchDenyRule(S.denylist, '1Password.exe', 'Vault')?.mode).toBe('block');
    expect(checkObservation(S, 'Bitwarden.exe', 'Bitwarden').decision).toBe('block');
  });
  it('requires confirmation for banking titles', () => {
    expect(matchDenyRule(S.denylist, 'msedge.exe', 'Chase Bank - Accounts')?.mode).toBe('confirm');
    expect(checkObservation(S, 'msedge.exe', 'Chase Bank').decision).toBe('allow');
  });
  it('block wins over confirm', () => {
    const rules = [
      { title: 'vault', mode: 'confirm' as const },
      { process: 'keepass', mode: 'block' as const },
    ];
    expect(matchDenyRule(rules, 'KeePass.exe', 'vault.kdbx')?.mode).toBe('block');
  });
});

describe('classifyAction', () => {
  it('allows ordinary clicks', () => {
    expect(classifyAction({ kind: 'click', process: 'notepad.exe', title: 'Untitled', elementName: 'File' }, S).decision).toBe('allow');
  });
  it('needs confirmation for send/submit/delete/buy/pay buttons', () => {
    for (const name of ['Send', 'Submit', 'Delete', 'Buy now', 'Pay $40.00', 'Place order', 'Transfer']) {
      expect(classifyAction({ kind: 'click', process: 'chrome.exe', title: 'Shop', elementName: name }, S).decision, name).toBe('confirm');
    }
  });
  it('treats the model description as a signal too', () => {
    expect(classifyAction({ kind: 'click', process: 'x.exe', description: 'Submit the form' }, S).decision).toBe('confirm');
  });
  it('flags send shortcuts', () => {
    expect(classifyAction({ kind: 'press_keys', keys: 'ctrl+enter', process: 'code.exe' }, S).decision).toBe('confirm');
    expect(classifyAction({ kind: 'press_keys', keys: 'alt+s', process: 'olk.exe' }, S).decision).toBe('confirm');
    expect(classifyAction({ kind: 'press_keys', keys: 'enter', process: 'slack.exe' }, S).decision).toBe('confirm');
    expect(classifyAction({ kind: 'press_keys', keys: 'enter', process: 'notepad.exe' }, S).decision).toBe('allow');
    expect(classifyAction({ kind: 'press_keys', keys: 'shift+delete', process: 'explorer.exe' }, S).decision).toBe('confirm');
  });
  it('flags newlines typed into messaging apps', () => {
    expect(classifyAction({ kind: 'type_text', text: 'hi\n', process: 'Teams.exe' }, S).decision).toBe('confirm');
    expect(classifyAction({ kind: 'type_text', text: 'hi\n', process: 'notepad.exe' }, S).decision).toBe('allow');
  });
  it('typing the word "send" is not itself risky', () => {
    expect(classifyAction({ kind: 'type_text', text: 'please send me the file', process: 'notepad.exe' }, S).decision).toBe('allow');
  });
  it('every action in a banking window needs confirmation; password managers are blocked', () => {
    expect(classifyAction({ kind: 'scroll', process: 'msedge.exe', title: 'My Bank' }, S).decision).toBe('confirm');
    expect(classifyAction({ kind: 'click', process: '1password.exe', title: '1Password' }, S).decision).toBe('block');
  });
  it('confirmAllActions makes everything but scrolling need confirmation', () => {
    const s = { ...S, confirmAllActions: true };
    expect(classifyAction({ kind: 'click', process: 'notepad.exe' }, s).decision).toBe('confirm');
    expect(classifyAction({ kind: 'scroll', process: 'notepad.exe' }, s).decision).toBe('allow');
  });
});

