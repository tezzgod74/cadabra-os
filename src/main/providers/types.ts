import type { AuthStatus, ModelOption, ProviderEvent, ProviderId } from '../../shared/types';

export interface SendRequest {
  /** The user's message. */
  prompt: string;
  /** Screenshot of the target window captured at summon time (base64 PNG), if allowed. */
  image?: { data: string; mimeType: 'image/png'; width: number; height: number };
  /** Short description of the target window / environment, prepended as context. */
  contextText: string;
  model: string;
  /** Provider session/thread id to continue, if any. */
  resumeId?: string;
  signal: AbortSignal;
}

export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly label: string;
  listModels(): Promise<ModelOption[]>;
  checkAuth(): Promise<AuthStatus>;
  /** Stream events for one user turn. Must finish with a 'done' or 'error' event. */
  send(req: SendRequest): AsyncIterable<ProviderEvent>;
  /** Start / warm the backend so the first token arrives sooner (optional). */
  prewarm?(model: string): Promise<void>;
  /** Forget the current conversation (next send starts fresh). */
  reset?(): void;
  /** The user stopped the run (Esc / "stop"): drop anything that could still call tools. */
  onAbort?(): void;
  /** Shut down any child processes. */
  dispose?(): Promise<void>;
  /** Ways to connect this backend (shown in onboarding / settings). */
  signInOptions?(): SignInOption[];
  /**
   * Connect. Vendor logins ALWAYS run in the vendor's own flow (its CLI opens
   * the vendor's page via `openUrl`); Cadabra never sees or stores those
   * credentials (docs/research.md §8.4). API keys are passed in `apiKey`.
   */
  signIn?(optionId: string, io: SignInIO): Promise<AuthStatus>;
  signOut?(): Promise<void>;
}

export interface SignInOption {
  id: string;
  /** Honest label, e.g. "Sign in with ChatGPT (via Codex)". */
  label: string;
  /** One-line explanation / terms note shown under the button. */
  note?: string;
  /** This option needs an API key / credential typed by the user. */
  needsKey?: boolean;
  keyPlaceholder?: string;
}

export interface SignInIO {
  apiKey?: string;
  /** Open a vendor URL in the user's default browser. */
  openUrl(url: string): void;
  /** Progress text for the UI ("Complete sign-in in your browser…"). */
  status?(text: string): void;
  signal?: AbortSignal;
}

/** Strip the MCP namespacing a backend adds to tool names ("mcp__cadabra__click" -> "click"). */
export function shortToolName(name: string): string {
  const m = /^(?:mcp__)?cadabra(?:__|\.|\/|-)(.+)$/.exec(name);
  if (m) return m[1];
  const parts = name.split('__');
  return parts[parts.length - 1];
}

export const TOOL_LABELS: Record<string, string> = {
  see_screen: 'Looked at the screen',
  read_ui: 'Read the window',
  highlight: 'Pointed it out',
  click: 'Clicked',
  type_text: 'Typed',
  press_keys: 'Pressed keys',
  scroll: 'Scrolled',
  confirm_with_user: 'Asked you',
  run_in_terminal: 'Ran a command',
  find_apps: 'Looked for apps',
  launch_app: 'Opened an app',
  focus_app: 'Switched apps',
  set_provider: 'Switched backend',
  set_model: 'Switched model',
  set_voice: 'Changed voice settings',
  change_shortcut: 'Changed the shortcut',
  pause_cadabra: 'Paused',
  get_weather: 'Checked the weather',
  search_email: 'Checked your email',
  read_email: 'Read an email',
  open_email: 'Opened Gmail',
  open_url: 'Opened a page',
  lock_pc: 'Locked the PC',
  end_conversation: 'Wrapped up',
};

export function buildUserText(req: Pick<SendRequest, 'prompt' | 'contextText'>): string {
  return req.contextText ? `${req.contextText}\n\n${req.prompt}` : req.prompt;
}
