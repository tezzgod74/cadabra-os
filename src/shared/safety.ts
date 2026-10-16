// Pure safety rules. The runtime gate (src/main/safety-gate.ts) uses these to
// decide whether an action may run, needs confirmation, or is blocked, and to
// render the confirm card from the REAL action (never the model's prose).

import type { DenyRule, SafetySettings } from './types';
import { checkCommand } from './terminal';
import { normalizeSpoken } from './speech';

export type ActionKind = 'click' | 'type_text' | 'press_keys' | 'scroll' | 'invoke' | 'set_value' | 'launch' | 'terminal' | 'open_url' | 'lock_pc' | 'web_fetch' | 'web_search' | 'send_screen' | 'announce';

export interface ActionRequest {
  kind: ActionKind;
  /** Target window process name, e.g. "outlook.exe". */
  process?: string;
  /** Target window title. */
  title?: string;
  /** Window class of the target (used to spot consoles / the Run dialog). */
  className?: string;
  /** Name / role of the UI element being acted on, when known. */
  elementName?: string;
  elementRole?: string;
  elementId?: number;
  /** true when the click lands on image coordinates with no resolved element. */
  blindClick?: boolean;
  /** Target window handle (for binding an approval to one window). */
  hwnd?: number;
  /** Text to type / value to set / command / launch path. */
  text?: string;
  /** Key chord for press_keys, e.g. "ctrl+enter". */
  keys?: string;
  /** Free-text description the model gave (subtitle only, never the decision). */
  description?: string;
  /** The user's own words this turn (risky payloads must trace to these). */
  prompt?: string;
  /** This payload came from screen content / tool output, not the user (real provenance). */
  fromScreen?: boolean;
  /** What has keyboard focus in the target (UIA), to spot IDE terminals, address bars, search boxes. */
  focus?: FocusInfo;
  /** Gate-read context for send-like actions: the compose field's text (N10). */
  composeText?: string;
  /** Round 11: where an "Always allow" grant would apply (app / site), resolved lazily. */
  scope?: () => Promise<{ key: string; label: string } | null>;
  /**
   * Round 11.7: the tool's own rule result (open_url, lock_pc, web fetch/search).
   * The gate still applies the autonomy level, email taint and grants on top.
   * `noEvery`: "Ask before every action" doesn't add cards for it (web search / fetch).
   */
  preset?: { decision: 'allow' | 'confirm' | 'block'; reasons: string[]; noEvery?: boolean };
  /** Round 11.5: the browser page's address (from the address bar), when known. */
  pageUrl?: string;
  /** Round 11.5: web content entered this turn and this unlabeled click is on a site the user didn't name. */
  offSiteAfterWeb?: boolean;
  /**
   * 0.9.14: this action erases text Cadabra didn't type this turn (select-all, then
   * Delete / Backspace / Cut / typing over it). `chars` null = couldn't be read.
   */
  erases?: { chars: number | null; reason: string };
}

export interface FocusInfo {
  role?: string;
  name?: string;
  aid?: string;
  className?: string;
  /** Process id of the focused element. */
  pid?: number;
  /** The focus was read inside the target (target in front, same process). */
  verified?: boolean;
}

export type Verdict =
  | { decision: 'allow'; reasons: string[] }
  | { decision: 'confirm'; reasons: string[] }
  | { decision: 'block'; reasons: string[] };

/** Processes whose windows run a shell: typing + Enter there is a command. */
export const SHELL_PROCESSES = [
  'windowsterminal',
  'wt',
  'conhost',
  'openconsole',
  'powershell',
  'pwsh',
  'cmd',
  'wsl',
  'wslhost',
  'bash',
  'sh',
  'mintty',
  'alacritty',
  'wezterm',
  'wezterm-gui',
  'hyper',
  'fluent terminal',
  'cmder',
  'conemu',
  'conemu64',
  'powershell_ise',
  'python',
  'pythonw',
  'node',
  'git-bash',
  'nu',
  'tabby',
  'warp',
  'bash.exe',
  'zsh',
  'fish',
  'ubuntu',
  'debian',
  'kali',
  'alpine',
  'arch',
  'archlinux',
  'fedora',
  'fedoraremix',
  'almalinux',
  'oraclelinux',
  'sles',
  'opensuse',
  'msys2',
  'mingw64',
  'ucrt64',
  'clink',
  'far',
];

/** WSL distro launchers and versioned shells ("ubuntu2204", "opensuse-leap-15.5", "wsl.exe"…). */
const SHELL_PATTERN = /^(wsl\w*|ubuntu[\w.-]*|debian\w*|kali[\w-]*|opensuse[\w.-]*|sles[\w.-]*|fedora[\w.-]*|oraclelinux[\w.-]*|almalinux[\w.-]*|alpine\w*|arch(linux)?\w*|python\d[\w.]*|pwsh[\w.-]*|powershell[\w.-]*)$/;

/** Window classes that are consoles or the Run / system dialogs. */
export const SHELL_CLASSES = ['consolewindowclass', 'cascadia_hosting_window_class', 'virtualconsoleclass', 'pseudoconsolewindowclass'];

/** Editors / IDEs with built-in terminals (a terminal pane runs what you type). */
export const IDE_PROCESSES = [
  'code', 'code - insiders', 'cursor', 'windsurf', 'vscodium', 'codium', 'zed', 'devenv', 'sublime_text', 'trae', 'kiro', 'void', 'positron',
  'idea64', 'idea', 'pycharm64', 'pycharm', 'rider64', 'webstorm64', 'clion64', 'goland64', 'phpstorm64',
  'rubymine64', 'datagrip64', 'rustrover64', 'studio64', 'fleet', 'eclipse', 'notepad++', 'aqua64', 'dataspell64', 'writerside64',
];

/** System places where typed text + Enter runs a program (REVIEW-2 #3). */
export const COMMAND_BOX_PROCESSES = ['searchhost', 'searchapp', 'searchui', 'startmenuexperiencehost', 'powertoys.powerlauncher', 'powertoys.run'];

const pname = (process?: string) => (process ?? '').toLowerCase().replace(/\.exe$/, '');

export function isShellTarget(process?: string, className?: string, focus?: FocusInfo): boolean {
  const p = pname(process);
  if (SHELL_PROCESSES.includes(p) || SHELL_PATTERN.test(p)) return true;
  const c = (className ?? '').toLowerCase();
  if (SHELL_CLASSES.includes(c)) return true;
  return shellKind(process, className, focus) != null;
}

/**
 * Why typing here would run a command, or null. Covers IDE terminal panes,
 * the File Explorer address bar, Start/Windows search and launcher boxes.
 */
export function shellKind(process?: string, className?: string, focus?: FocusInfo): string | null {
  const p = pname(process);
  if (SHELL_PROCESSES.includes(p) || SHELL_PATTERN.test(p) || SHELL_CLASSES.includes((className ?? '').toLowerCase())) return 'Runs in a terminal';
  if (COMMAND_BOX_PROCESSES.includes(p)) return 'Windows search / launcher runs what you type';
  const f = focus ?? {};
  const fc = (f.className ?? '').toLowerCase();
  const fn = (f.name ?? '').toLowerCase();
  const fa = (f.aid ?? '').toLowerCase();
  const fr = (f.role ?? '').toLowerCase();
  if (IDE_PROCESSES.includes(p) && (/xterm|terminal/.test(fc) || /terminal/.test(fn) || /terminal/.test(fa) || fr === 'terminal')) return 'Runs in the editor\'s terminal';
  // REVIEW-3 S3-R: in an editor/IDE whose focus we couldn't verify inside the
  // target, assume it may be a terminal pane (fail closed).
  if (IDE_PROCESSES.includes(p) && focus && !focus.verified) return 'Cadabra can’t confirm whether this goes into the editor or its terminal';
  if (p === 'explorer' && (fa === '41477' || /address/.test(fn) || fc === 'breadcrumb parent' || (fr === 'edit' && /address|search/.test(fn)))) {
    return 'The File Explorer address bar runs what you type';
  }
  return null;
}

/**
 * Run-style dialogs (Win+R "Run", Task Manager "Create new task"): detected
 * by class + owner process, not by the (localised) title.
 */
export function isLauncherDialog(title?: string, className?: string, process?: string): boolean {
  const t = (title ?? '').toLowerCase();
  const c = (className ?? '').toLowerCase();
  const p = pname(process);
  if (c !== '#32770') return false;
  if (p === 'taskmgr') return true; // "Create new task"
  if (p === 'explorer' && (/^(run|ausführen|exécuter|ejecutar|esegui|executar|uitvoeren|uruchom|выполнить|実行|执行|執行|실행)$/.test(t) || t.length <= 14)) return true;
  if (/^run$/.test(t)) return true;
  return false;
}

/** Browser processes; a browser tab can be mail/chat/banking (REVIEW-2 S8). */
export const BROWSER_PROCESSES = ['chrome', 'msedge', 'firefox', 'brave', 'opera', 'vivaldi', 'arc', 'iexplore', 'thorium', 'librewolf', 'waterfox', 'zen'];
const WEB_MESSAGING = /\b(gmail|inbox|outlook|mail|slack|whatsapp|messenger|teams|discord|telegram|signal|linkedin|messages|chat|proton ?mail|yahoo mail|icloud)\b/i;

export function isBrowser(process?: string): boolean {
  return BROWSER_PROCESSES.includes(pname(process));
}

export const DEFAULT_SAFETY: SafetySettings = {
  denylist: [
    { process: '1password', mode: 'block', label: 'Password manager' },
    { process: 'bitwarden', mode: 'block', label: 'Password manager' },
    { process: 'keepass', mode: 'block', label: 'Password manager' },
    { process: 'keepassxc', mode: 'block', label: 'Password manager' },
    { process: 'lastpass', mode: 'block', label: 'Password manager' },
    { process: 'dashlane', mode: 'block', label: 'Password manager' },
    { process: 'protonpass', mode: 'block', label: 'Password manager' },
    { process: 'credentialuibroker', mode: 'block', label: 'Windows credential prompt' },
    { process: 'consent.exe', mode: 'block', label: 'UAC prompt' },
    { process: 'logonui', mode: 'block', label: 'Windows sign-in' },
    { title: 'password', mode: 'confirm', label: 'Password-related window' },
    { title: 'bank', mode: 'confirm', label: 'Banking' },
    { title: 'banking', mode: 'confirm', label: 'Banking' },
    { title: 'paypal', mode: 'confirm', label: 'Payments' },
    { title: 'venmo', mode: 'confirm', label: 'Payments' },
    { title: 'robinhood', mode: 'confirm', label: 'Trading' },
    { title: 'brokerage', mode: 'confirm', label: 'Trading' },
    { title: 'trading', mode: 'confirm', label: 'Trading' },
    { title: 'coinbase', mode: 'confirm', label: 'Crypto' },
    { title: 'binance', mode: 'confirm', label: 'Crypto' },
    { title: 'schwab', mode: 'confirm', label: 'Trading' },
    { title: 'fidelity', mode: 'confirm', label: 'Trading' },
    { title: 'checkout', mode: 'confirm', label: 'Checkout' },
    { process: 'thinkorswim', mode: 'confirm', label: 'Trading' },
  ],
  riskyWords: [
    'send', 'submit', 'delete', 'remove', 'erase', 'purchase', 'buy', 'pay', 'payment', 'checkout', 'check out',
    'place order', 'order now', 'transfer', 'wire', 'withdraw', 'deposit', 'trade', 'sell', 'confirm', 'publish',
    'post', 'reply all', 'forward', 'uninstall', 'format', 'reset', 'discard', 'empty trash', 'sign out', 'log out',
    'unsubscribe', 'accept', 'approve', 'merge', 'deploy', 'overwrite', 'permanently',
  ],
  messagingApps: [
    'outlook', 'olk', 'thunderbird', 'teams', 'ms-teams', 'slack', 'discord', 'whatsapp', 'telegram', 'signal',
    'messenger', 'skype', 'zoom',
  ],
  maxActionsPerRun: 40,
  confirmAllActions: false,
  autonomy: 'risky',
  grants: [],
};

const lc = (s: string | undefined) => (s ?? '').toLowerCase();

export function matchDenyRule(rules: DenyRule[], process?: string, title?: string): DenyRule | undefined {
  const p = lc(process);
  const t = lc(title);
  const hits = rules.filter((r) => (r.process ? p.includes(lc(r.process)) : true) && (r.title ? t.includes(lc(r.title)) : true) && (r.process || r.title));
  return hits.find((r) => r.mode === 'block') ?? hits[0];
}

/** Whole-word-ish match so "resend" or "description" don't trip "send"/"script". */
export function findRiskyWords(text: string, words: string[]): string[] {
  const t = lc(text);
  if (!t) return [];
  const found: string[] = [];
  for (const w of words) {
    const esc = lc(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    if (new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`).test(t)) found.push(w);
  }
  return found;
}

const KEY_ALIASES: Record<string, string> = {
  return: 'enter',
  control: 'ctrl',
  lctrl: 'ctrl',
  rctrl: 'ctrl',
  del: 'delete',
  escape: 'esc',
  option: 'alt',
  opt: 'alt',
  menu: 'alt',
  lalt: 'alt',
  ralt: 'alt',
  altgr: 'alt',
  lshift: 'shift',
  rshift: 'shift',
  win: 'win',
  windows: 'win',
  lwin: 'win',
  rwin: 'win',
  meta: 'win',
  super: 'win',
  cmd: 'win',
  command: 'win',
  start: 'win',
  ins: 'insert',
};

/** Canonical key names (mirrors every alias native/cadabra-helper/src/keys.rs accepts). */
export function normalizeChord(keys: string): string[] {
  return lc(keys)
    .split('+')
    .map((k) => k.trim())
    .map((k) => KEY_ALIASES[k] ?? k);
}

/** System / launcher chords Cadabra refuses to press even with a target. */
export function blockedChord(keys: string): string | null {
  const k = normalizeChord(keys);
  const has = (x: string) => k.includes(x);
  if (has('win')) {
    // Win+R (run), Win+X (power menu), Win+L (lock), Win+E, Win+I, Win+anything launcher/system.
    return `${keys} is a Windows system shortcut`;
  }
  if (has('ctrl') && has('shift') && has('esc')) return 'Ctrl+Shift+Esc opens Task Manager';
  if (has('ctrl') && has('esc')) return 'Ctrl+Esc opens the Start menu';
  if (has('ctrl') && has('alt') && has('delete')) return 'Ctrl+Alt+Del is reserved by Windows';
  return null;
}

/** Viewing (see_screen / read_ui) is only blocked by 'block' rules. */
export function checkObservation(s: SafetySettings, process?: string, title?: string): Verdict {
  const rule = matchDenyRule(s.denylist, process, title);
  if (rule?.mode === 'block') return { decision: 'block', reasons: [`${rule.label ?? 'Protected app'} — Cadabra won't look at or touch this window`] };
  return { decision: 'allow', reasons: [] };
}

/**
 * Does the payload trace to the user's own words this turn? An empty
 * significant-token list only counts as "yes" when `allowEmpty` (REVIEW-2:
 * "rm -rf ~" has no 3+ char token and must not slip through).
 */
export function payloadInUtterance(payload: string | undefined, prompt: string | undefined, allowEmpty = true): boolean {
  if (!payload || !payload.trim()) return true;
  const raw = lc(prompt);
  if (!raw) return false;
  // Voice prompts say "eight point eight point eight point eight".
  const u = `${raw} ${normalizeSpoken(raw)}`;
  const toks = lc(payload).match(/[\p{L}\p{N}][\p{L}\p{N}.+_-]{2,}/gu) ?? [];
  if (!toks.length) return allowEmpty;
  return toks.every((tok) => u.includes(tok) || u.replace(/[^\p{L}\p{N}]/gu, '').includes(tok.replace(/[^\p{L}\p{N}]/gu, '')));
}

/** Round 11.5: sign-in / payment / checkout / verification pages (title or address). */
const SENSITIVE_PAGE = /\b(sign[ -]?in|log[ -]?in|login|signin|password|verify|verification|confirm your (account|identity)|2fa|two[- ]factor|one[- ]time (code|password)|payment|pay now|checkout|check out|billing|card details|wallet|transfer|bank|account security|security check)\b|\/(login|signin|checkout|payment|pay|billing|verify|auth|oauth|account\/security)\b/i;

/** Round 11.6: neutral "next step" buttons that commit something on a sensitive page. */
const NEUTRAL_STEP = /^(continue|next|proceed|confirm|submit|done|ok|okay|verify|sign in|signin|log in|login|place (your )?order|pay( now)?|complete( purchase| order)?|review order|agree( and continue)?|accept|yes|save|update|finish|go)\b/i;

/** Round 11: copied screen text that looks like a command or a web address (prompt-injection payloads) is still carded in the default level. */
const COMMANDISH = /https?:\/\/|\b(curl|wget|iwr|irm|powershell|pwsh|cmd(\.exe)?|bash|ssh|scp|invoke-\w+|start-process|reg (add|delete)|rm -|del |format |net user|certutil|mshta|rundll32)\b|\|\s*iex\b/i;

/** Round 11: the autonomy level in effect (confirmAllActions = the old "ask every time"). */
export function autonomyOf(s: SafetySettings): 'risky' | 'every' | 'none' {
  return s.confirmAllActions ? 'every' : (s.autonomy ?? 'risky');
}

/**
 * Round 11 (user: "why are there prompts to allow Cadabra to click?"): the
 * autonomy level re-tiers the rules. Blocks always apply. 'none' turns every
 * card into an allow. 'every' cards everything but scrolling.
 */
export function classifyAction(req: ActionRequest, s: SafetySettings): Verdict {
  const v = classifyActionRaw(req, s);
  if (v.decision === 'confirm' && autonomyOf(s) === 'none') return { decision: 'allow', reasons: v.reasons };
  return v;
}

/** A stable id for a gate reason (for the log; never the payload). */
export function reasonId(reason: string): string {
  const r = reason.toLowerCase();
  if (/text cadabra didn.t type/.test(r)) return 'erase-text';
  if (/no window is in focus/.test(r)) return 'S4-no-target';
  if (/run box/.test(r)) return 'run-box';
  if (/^clicks “.*” on a sign-in, payment/.test(r)) return 'sensitive-page';
  // Round 11.7: open_url / lock_pc / web reasons.
  if (/this address came from your screen|carries text from your screen/.test(r)) return 'url-screen';
  if (/looks like a file name/.test(r)) return 'url-file';
  if (/you didn.t name this site|site you didn.t name|more in its address than you asked/.test(r) && !/unlabeled/.test(r)) return 'url-unnamed';
  if (/you didn.t ask to lock/.test(r)) return 'lock-unasked';
  if (/you didn.t ask for an announcement/.test(r)) return 'announce-unasked';
  if (/using the microphone/.test(r)) return 'lock-call';
  if (/didn.t come from you or from this search|includes text from your screen|looks private|web access is off|stopped/.test(r)) return 'web-guard';
  if (/local network|this pc|bare ip|special port|user name or password|only https|only http|valid web address/.test(r)) return 'url-local';
  if (/terminal|shell|command|runs whatever|runs in the editor|editor or its terminal/.test(r)) return 'S3-shell';
  if (/allowlist|isn't in your app list|program/.test(r)) return 'launch-path';
  if (/host you did not name/.test(r)) return 'host';
  if (/code or number/.test(r)) return 'S7-secret';
  if (/copied from the screen/.test(r)) return 'S7-screen-text';
  if (/unlabeled/.test(r) && /messages are sent/.test(r)) return 'S8-messaging';
  if (/unlabeled/.test(r) && /payments|banking/.test(r)) return 'S8-finance';
  if (/unlabeled/.test(r) && /sign-in|payment|checkout|verification|account page/.test(r)) return 'S8-sensitive-page';
  if (/unlabeled/.test(r) && /didn.t name/.test(r)) return 'web-taint';
  if (/unlabeled/.test(r)) return 'S8-web';
  if (/looks like it could/.test(r)) return 'risky-word';
  if (/send|submit/.test(r)) return 'send';
  if (/permanently deletes|closes the window/.test(r)) return 'destructive-key';
  if (/confirm-all|ask before every/.test(r)) return 'every';
  if (/email/.test(r)) return 'email-taint';
  if (/banking|payments|trading|crypto|checkout|password|sensitive app/.test(r)) return 'denylist-confirm';
  if (/blocked|protected app/.test(r)) return 'block';
  return 'other';
}

/** Round 11: may the user say "Always allow this" for a card with these reasons? */
/**
 * Round 11.5 (REVIEW-11 R11-1, High): "Always allow" is only for ORDINARY
 * actions — cards that exist because of "Ask before every action", or an
 * unlabeled click on an ordinary web page. Never for anything risky: send /
 * post / submit, buy / pay / transfer, delete or destructive keys, banking /
 * trading / messaging apps, shells and terminal commands, system chords,
 * screen-text or secret typing, sensitive pages, after web content or email.
 * The gate checks this BEFORE looking at grants, so an old grant can never
 * suppress a risky card.
 */
export function grantable(req: ActionRequest, reasons: string[]): boolean {
  // Round 11.7: opening ordinary pages on a site can be granted per registrable domain.
  if (req.kind === 'open_url') return reasons.length > 0 && reasons.every((x) => ['every', 'url-unnamed'].includes(reasonId(x)));
  if (!['click', 'invoke', 'type_text', 'set_value', 'press_keys', 'scroll'].includes(req.kind)) return false;
  return reasons.length > 0 && reasons.every((x) => ['every', 'S8-web'].includes(reasonId(x)));
}

export function grantClass(kind: ActionKind): 'click' | 'type' | 'keys' | 'scroll' | 'open' | null {
  if (kind === 'open_url') return 'open';
  return kind === 'click' || kind === 'invoke' ? 'click' : kind === 'type_text' || kind === 'set_value' ? 'type' : kind === 'press_keys' ? 'keys' : kind === 'scroll' ? 'scroll' : null;
}

function classifyActionRaw(req: ActionRequest, s: SafetySettings): Verdict {
  const level = autonomyOf(s);
  // Round 11.7: open_url / lock_pc / web tools bring their own rule result.
  if (req.preset) {
    const p = req.preset;
    if (p.decision === 'allow' && level === 'every' && !p.noEvery) return { decision: 'confirm', reasons: ['Ask before every action is on'] };
    return { decision: p.decision, reasons: p.reasons } as Verdict;
  }
  const reasons: string[] = [];
  const rule = matchDenyRule(s.denylist, req.process, req.title);
  if (rule?.mode === 'block') return { decision: 'block', reasons: [`${rule.label ?? 'Protected app'} — actions are blocked here`] };
  if (rule) reasons.push(`${rule.label ?? 'Sensitive app'} (${req.process ?? req.title})`);

  const isInput = req.kind === 'type_text' || req.kind === 'press_keys' || req.kind === 'set_value' || req.kind === 'click' || req.kind === 'scroll';
  // 0.9.14: erasing the user's own text (e.g. unsaved tabs an app restored) always asks first.
  if (req.erases) reasons.push(req.erases.reason);

  // S4: no valid target → refuse input until see_screen/read_ui establishes one.
  if (isInput && !req.process && !req.title && req.kind !== 'scroll' && !req.hwnd) {
    return { decision: 'block', reasons: ['No window is in focus to act on. Call see_screen or read_ui first so Cadabra knows what it is touching.'] };
  }
  if (isInput && isLauncherDialog(req.title, req.className, req.process)) {
    return { decision: 'confirm', reasons: ['This is a Run box: whatever is typed here runs as a program'] };
  }

  if (req.kind === 'terminal') {
    const chk = req.text ? checkCommand(req.text) : { allowed: false, reason: 'no command', command: '' };
    if (!chk.allowed && req.text) reasons.push(chk.reason);
    else if (req.text && !payloadInUtterance(hostsOf(chk.command).join(' '), req.prompt)) reasons.push('Reaches out to a host you did not name');
    return reasons.length ? { decision: 'confirm', reasons } : { decision: 'allow', reasons };
  }
  if (req.kind === 'launch') {
    if (req.text) reasons.push(`Runs a program that isn't in your app list: ${req.text}`);
    return reasons.length ? { decision: 'confirm', reasons } : { decision: 'allow', reasons };
  }

  if (level === 'every' && req.kind !== 'scroll') reasons.push('Ask before every action is on');

  const shellWhy = shellKind(req.process, req.className, req.focus);
  const ide = IDE_PROCESSES.includes(pname(req.process));
  const isMessaging = s.messagingApps.some((m) => lc(req.process).includes(lc(m))) || (isBrowser(req.process) && WEB_MESSAGING.test(req.title ?? ''));
  const typed = (req.kind === 'type_text' || req.kind === 'set_value') && !!req.text && !!req.text.trim();

  // S3: typing / Enter / paste into anything that runs commands. Always a card,
  // whatever the tokens are (closes the short-token hole: "rm -rf ~").
  if (shellWhy && typed) reasons.push(`${shellWhy}: Cadabra will type exactly this`);
  else if (typed && ide && !req.focus) reasons.push('Cadabra can’t confirm whether this goes into the editor or its terminal');
  if (!shellWhy && ide && !req.focus && req.kind === 'press_keys' && req.keys) {
    const k = normalizeChord(req.keys);
    if (k.includes('enter') || (k.includes('ctrl') && k.includes('v')) || (k.includes('shift') && k.includes('insert'))) reasons.push('Cadabra can’t confirm whether this runs in the editor’s terminal');
  }
  if (shellWhy && req.kind === 'press_keys' && req.keys) {
    const k = normalizeChord(req.keys);
    if (k.includes('enter') || (k.includes('ctrl') && k.includes('v')) || (k.includes('shift') && k.includes('insert'))) reasons.push(`${shellWhy}: this runs whatever is typed there`);
  }

  // REVIEW-3 S7-R: short secrets (one-time codes, PINs, card numbers, IBANs,
  // API-key-like tokens) the user didn't give are carded whatever their length,
  // whether read via the UI tree or from a screenshot (no OCR needed: fail closed).
  if (typed && isSecretLike(req.text!) && !payloadInUtterance(req.text, req.prompt, false)) {
    reasons.push('Types a code or number you didn’t give Cadabra (it could be a one-time code, PIN or card number)');
  }

  // S7/N6: only text Cadabra actually *read on the screen* (real provenance) and
  // the user didn't ask for needs a card. Model-written prose runs freely.
  // Round 11: in the default level ordinary copied text (an address, a name) types freely;
  // codes / numbers above are still carded.
  if (typed && req.fromScreen && (level === 'every' || COMMANDISH.test(req.text!)) && !payloadInUtterance(req.text, req.prompt, false)) {
    reasons.push('Types text copied from the screen, not from your request');
  }

  // Risky words on the element / description (NOT on typed text — that would flag "please send me the file").
  const words = findRiskyWords([req.elementName, req.description].filter(Boolean).join(' \n '), s.riskyWords);
  if (words.length && (req.kind === 'click' || req.kind === 'invoke' || req.kind === 'press_keys')) {
    reasons.push(`Looks like it could ${words.slice(0, 3).join(' / ')}`);
  }

  const isFinance = rule?.mode === 'confirm';

  // S8: a blind coordinate click on an unnamed control in a messaging/finance app,
  // or on an unnamed button in any browser tab (could be Gmail's Send icon).
  // Round 11: ordinary web pages (Maps, search results…) no longer card unlabeled
  // clicks in the default level; messaging / payments pages still do.
  // Round 11.5 (REVIEW-11 #3): pages that take money or credentials stay carded in the default level.
  const sensitivePage = isBrowser(req.process) && SENSITIVE_PAGE.test(`${req.title ?? ''} ${req.pageUrl ?? ''}`);
  if (req.kind === 'click' && req.blindClick && !req.elementName && (isMessaging || isFinance || sensitivePage || (level === 'every' && isBrowser(req.process)))) {
    reasons.push(isMessaging ? 'Clicks an unlabeled button where messages are sent (could be Send)' : isFinance ? 'Clicks an unlabeled control in a payments/banking window' : sensitivePage ? 'Clicks an unlabeled control on a sign-in, payment, checkout or verification page' : 'Clicks an unlabeled button on a web page (could be Send / Pay)');
  }
  // Round 11.6 (REVIEW-11.5): on those pages a LABELED neutral button ("Continue",
  // "Next", "Verify", "Sign in"…) can be what pays or signs in, so it asks too.
  if (req.kind === 'click' && req.elementName && sensitivePage && NEUTRAL_STEP.test(req.elementName.trim())) {
    reasons.push(`Clicks “${req.elementName.trim().slice(0, 40)}” on a sign-in, payment, checkout or verification page`);
  }
  // Round 11.5: web content (search results, fetched pages) can steer the AI to
  // another site; unlabeled clicks there ask first. The site the user named stays silent.
  if (req.kind === 'click' && req.offSiteAfterWeb && !req.elementName && level !== 'none') reasons.push('Clicks an unlabeled control on a site you didn’t name, after reading web content');

  if (req.kind === 'press_keys' && req.keys) {
    const blocked = blockedChord(req.keys);
    if (blocked) reasons.push(blocked);
    const k = normalizeChord(req.keys);
    const has = (x: string) => k.includes(x);
    if (has('enter') && isMessaging) reasons.push('This will send the message');
    else if ((has('ctrl') || has('alt')) && has('enter')) reasons.push(`${req.keys} often sends or submits`);
    else if (has('alt') && has('s')) reasons.push(isMessaging ? 'This will send the message' : `${req.keys} is a common "send" shortcut`);
    if (has('delete') && has('shift')) reasons.push('Shift+Delete permanently deletes');
  }
  if (typed && /\n/.test(req.text!) && isMessaging) reasons.push('The line break will send the message');
  if (has_f4(req)) reasons.push('Closes the window');
  return reasons.length ? { decision: 'confirm', reasons } : { decision: 'allow', reasons };
}

/** One-time codes, PINs, card numbers (Luhn), IBANs and key-like tokens. */
export function isSecretLike(text: string): boolean {
  const t = text.trim();
  if (/^\d{4,8}$/.test(t)) return true; // OTP / PIN
  if (/^[A-Z0-9]{3}-?[A-Z0-9]{3}$/.test(t) && /\d/.test(t)) return true; // "ABC-123" style codes
  const digits = t.replace(/[\s-]/g, '');
  if (/^\d{12,19}$/.test(digits) && luhn(digits)) return true; // card number
  if (/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(t.replace(/\s/g, '').toUpperCase()) && /^[A-Za-z]{2}\d{2}/.test(t.replace(/\s/g, ''))) return true; // IBAN
  if (/^(sk|pk|ghp|gho|xox[abp]|AIza|AKIA)[-_A-Za-z0-9]{12,}$/.test(t)) return true; // API keys / tokens
  return false;
}

function luhn(d: string): boolean {
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let x = +d[d.length - 1 - i];
    if (i % 2) {
      x *= 2;
      if (x > 9) x -= 9;
    }
    sum += x;
  }
  return sum % 10 === 0;
}

function has_f4(req: ActionRequest): boolean {
  if (req.kind !== 'press_keys' || !req.keys) return false;
  const k = normalizeChord(req.keys);
  return k.includes('alt') && k.includes('f4');
}

/** Hostnames / IPs that a command reaches out to (for the "did you name it?" check). */
export function hostsOf(command: string): string[] {
  const parts = command.trim().split(/\s+/).slice(1);
  // Any non-flag argument that could resolve: dotted names, IPs, single labels, decimal IPs.
  return parts.filter((p) => !p.startsWith('-') && !p.startsWith('/') && !/^\d{1,3}$/.test(p) && /^[a-z0-9][a-z0-9.:-]*$/i.test(p));
}

// --------------------------------------------------------- action binding --

/** A stable, human-free fingerprint of exactly what an action will do. */
export function actionHash(req: ActionRequest): string {
  const target = req.elementId != null ? `el:${req.elementId}` : req.hwnd != null ? `hwnd:${req.hwnd}` : `win:${lc(req.process)}`;
  switch (req.kind) {
    case 'terminal':
      return `terminal|${(req.text ?? '').trim().replace(/\s+/g, ' ')}`;
    case 'launch':
      return `launch|${lc(req.text)}`;
    case 'press_keys':
      return `press_keys|${normalizeChord(req.keys ?? '').join('+')}|${target}`;
    case 'type_text':
    case 'set_value':
      return `${req.kind}|${req.text ?? ''}|${target}`;
    case 'click':
      return `click|${target}|${lc(req.elementName)}`;
    case 'open_url':
    case 'web_fetch':
    case 'web_search':
      return `${req.kind}|${req.text ?? ''}`;
    default:
      return `${req.kind}|${target}`;
  }
}

/** Friendly app name for cards ("olk.exe" -> "Outlook"). */
export function appLabel(process?: string, title?: string): string {
  const p = pname(process);
  const known: Record<string, string> = {
    olk: 'Outlook', outlook: 'Outlook', 'ms-teams': 'Teams', teams: 'Teams', slack: 'Slack', discord: 'Discord', whatsapp: 'WhatsApp',
    telegram: 'Telegram', signal: 'Signal', thunderbird: 'Thunderbird', code: 'VS Code', cursor: 'Cursor', explorer: 'File Explorer',
    windowsterminal: 'Windows Terminal', powershell: 'PowerShell', pwsh: 'PowerShell', cmd: 'Command Prompt', chrome: 'Chrome', msedge: 'Edge', firefox: 'Firefox',
  };
  return known[p] ?? (title?.split(/ [-—–|] /).pop()?.trim() || process || 'this window');
}

/** Gate-authored confirm card (never the model's words). Titles state the consequence. */
export function describeAction(req: ActionRequest, reasons: string[]): { title: string; detail: string; risk: string; mono?: string } {
  const where = req.title || req.process || 'the current window';
  const app = appLabel(req.process, req.title);
  const why = reasons[0] ?? '';
  const sendLike = reasons.some((r) => /send the message|where messages are sent/.test(r));
  const compose = req.composeText ? `Message: “${req.composeText.slice(0, 300)}${req.composeText.length > 300 ? '…' : ''}”` : '';
  // 0.9.14: erasing text Cadabra didn't type: say how much, plainly.
  if (req.erases) {
    const n = req.erases.chars;
    const what = n == null ? 'the text' : `${n.toLocaleString('en-US')} character${n === 1 ? '' : 's'} of text`;
    return {
      title: `Erase ${what} in ${app}?`,
      detail: 'Cadabra didn’t type this text. It may be your own unsaved work (for example a tab the app reopened).',
      mono: req.kind === 'type_text' ? req.text : req.keys,
      risk: `${reasons.filter((x) => x !== req.erases!.reason)[0] ?? 'Select all, then erase'} · in ${where}`,
    };
  }
  switch (req.kind) {
    case 'terminal':
      return { title: 'Run this command?', detail: '', mono: req.text, risk: why || 'In a terminal window' };
    case 'open_url':
      return { title: 'Open this web page?', detail: '', mono: req.text, risk: why || 'In your browser' };
    case 'lock_pc':
      return { title: 'Lock this PC now?', detail: '', risk: why };
    case 'announce':
      return { title: 'Announce this out loud on the PC?', detail: '', mono: req.text, risk: why || 'Spoken through the PC’s speakers' };
    case 'send_screen':
      return { title: 'Send a picture of your screen to WhatsApp?', detail: '', risk: why || 'It leaves your PC (Meta’s agent service keeps media up to 30 days)' };
    case 'web_fetch':
      return { title: 'Open this web address?', detail: '', mono: req.text, risk: why };
    case 'web_search':
      return { title: 'Search the web for this?', detail: '', mono: req.text, risk: why };
    case 'launch':
      return { title: 'Run this program?', detail: '', mono: req.text, risk: why || 'Not in your installed-apps list' };
    case 'press_keys':
      if (sendLike) return { title: `Send this message in ${app}?`, detail: compose, mono: req.keys, risk: `${why} · keys ${req.keys} · in ${where}` };
      if (has_f4(req)) return { title: `Close ${app}?`, detail: '', mono: req.keys, risk: `${why} · in ${where}` };
      return { title: `Press ${req.keys}?`, detail: '', mono: req.keys, risk: `${why || 'Keyboard shortcut'} · in ${where}` };
    case 'type_text':
      return {
        title: shellKind(req.process, req.className, req.focus) ? `Type this command in ${app}?` : sendLike ? `Type and send this in ${app}?` : `Type this in ${app}?`,
        detail: '',
        mono: req.text,
        risk: `${why || ''} · in ${where}`.replace(/^ · /, ''),
      };
    case 'set_value':
      return { title: `Fill in ${req.elementName ? `“${req.elementName}”` : 'this field'}?`, detail: '', mono: req.text, risk: `${why || ''} · in ${where}`.replace(/^ · /, '') };
    case 'click':
      if (sendLike) return { title: `Send this message in ${app}?`, detail: compose, risk: `${why} · in ${where}` };
      return { title: req.elementName ? `Click “${req.elementName}”?` : 'Click here?', detail: '', risk: `${why || ''} · in ${where}`.replace(/^ · /, '') };
    default:
      return { title: `Do this in ${app}?`, detail: '', risk: `${why || ''} · in ${where}`.replace(/^ · /, '') };
  }
}

/**
 * REVIEW-2 #5: what Cadabra says out loud for a card in a voice conversation.
 * Written by the gate from the card (never model prose); commands are read back
 * exactly so a listener knows what "yes" means.
 */
export function spokenCard(card: { title: string; mono?: string }, req: Pick<ActionRequest, 'kind'>): string {
  const q = card.title.replace(/\?$/, '');
  const ask = `Should I ${q.charAt(0).toLowerCase()}${q.slice(1)}`;
  if (card.mono && (req.kind === 'terminal' || req.kind === 'launch' || req.kind === 'type_text' || req.kind === 'set_value')) {
    const m = card.mono.length > 140 ? `${card.mono.slice(0, 140)}…` : card.mono;
    return `${ask}: ${m.replace(/\n/g, ', then Enter, ')}? Say yes or no.`;
  }
  if (card.mono && req.kind === 'press_keys') return `${ask}? That presses ${card.mono.replace(/\+/g, ' plus ')}. Say yes or no.`;
  return `${ask}? Say yes or no.`;
}
