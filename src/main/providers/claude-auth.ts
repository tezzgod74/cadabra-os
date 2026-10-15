// The auth boundary for Claude. Both Claude modes run the user's own,
// separately installed Claude Code app (`claude -p`, see claude-cli.ts):
//
//  - 'claude-code' (subscription): the user's own Claude Code login; no key or
//    other credential of Cadabra's ever reaches the process;
//  - 'api-key' / 'bedrock' / 'vertex': the same binary in `--bare` mode with
//    only the chosen route's credentials.
//
// REVIEW-3 AUTH-1: API-key mode must never be able to fall back to the user's
// claude.ai login. Four layers, each sufficient on its own:
//  1. no key → refuse to start (nothing is spawned);
//  2. the child's environment is scrubbed of every OAuth / alternative-auth
//     variable and carries only the chosen route's credentials (the key is
//     passed only in that child's environment, never on the command line);
//  3. CLAUDE_CONFIG_DIR points at a Cadabra-owned empty folder and `--bare`
//     tells Claude Code never to read OAuth or the keychain;
//  4. preventive: before any message is sent, Claude Code's own `initialize`
//     answer reports the credential source (account.apiKeySource /
//     tokenSource / apiProvider). Anything but the route's credential, or no
//     answer at all, stops the session (fail closed). The `system/init` event
//     of each turn is checked again as a backstop.

/** Variables that could make the runtime authenticate some other way. */
export const AUTH_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_CUSTOM_HEADERS',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_REFRESH_TOKEN',
  'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
  'CLAUDE_CODE_SKIP_VERTEX_AUTH',
  'CLAUDE_CODE_SKIP_FOUNDRY_AUTH',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'ANTHROPIC_FOUNDRY_BASE_URL',
  'ANTHROPIC_FOUNDRY_RESOURCE',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_VERTEX_BASE_URL',
];

/**
 * Other providers' credentials Claude Code honours. The API-key route drops
 * them all (only our key may authenticate); Bedrock / Vertex keep their own.
 */
export const OTHER_PROVIDER_ENV_VARS = ['AWS_BEARER_TOKEN_BEDROCK', 'ANTHROPIC_VERTEX_PROJECT_ID', 'CLOUD_ML_REGION', 'ANTHROPIC_FOUNDRY_API_KEY'];

export type ClaudeRoute = 'api-key' | 'claude-code' | 'bedrock' | 'vertex';

export class NoApiKeyError extends Error {
  constructor() {
    super('Add an Anthropic API key in Settings → AI accounts → Claude (or choose “Use my Claude subscription”).');
  }
}

/** Shown when the credential check fails before anything was sent. */
export const AUTH_REFUSED_BEFORE_SEND = 'Stopped: Claude wasn’t going to use your API key, so Cadabra didn’t send anything. Check Settings → AI accounts → Claude.';
/** Shown when a turn's own report shows another credential (backstop). */
export const AUTH_REFUSED_IN_TURN = 'Stopped: Claude wasn’t using your API key, so Cadabra ended the request. Check Settings → AI accounts → Claude.';

/**
 * Environment for Claude Code in API-key / Bedrock / Vertex mode. Pure, so the
 * boundary is unit-tested. Throws when the API-key route has no key.
 */
export function claudeApiEnv(base: NodeJS.ProcessEnv, o: { route: Exclude<ClaudeRoute, 'claude-code'>; key?: string; configDir: string; version: string }): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const k of Object.keys(env)) if (AUTH_ENV_VARS.includes(k) || /^CLAUDE_CODE_OAUTH/i.test(k)) delete env[k];
  // API-key route: nothing but our key — every ANTHROPIC_* setting and every
  // other provider's credential goes (defence in depth; the initialize check
  // would refuse them anyway).
  if (o.route === 'api-key') for (const k of Object.keys(env)) if (/^ANTHROPIC_/i.test(k) || OTHER_PROVIDER_ENV_VARS.includes(k)) delete env[k];
  if (o.route === 'vertex') delete env.AWS_BEARER_TOKEN_BEDROCK;
  env.CLAUDE_AGENT_SDK_CLIENT_APP = `cadabra-os/${o.version}`;
  env.CLAUDE_CONFIG_DIR = o.configDir;
  if (o.route === 'bedrock') env.CLAUDE_CODE_USE_BEDROCK = '1';
  else if (o.route === 'vertex') env.CLAUDE_CODE_USE_VERTEX = '1';
  else {
    if (!o.key?.trim()) throw new NoApiKeyError();
    env.ANTHROPIC_API_KEY = o.key.trim();
  }
  return env;
}

/** Backstop (each turn's system/init): is the credential the one this route allows? */
export function authSourceAllowed(route: ClaudeRoute, init: { apiKeySource?: string }): boolean {
  if (route === 'api-key') return init.apiKeySource === 'ANTHROPIC_API_KEY';
  if (route === 'bedrock' || route === 'vertex') return init.apiKeySource === 'none' || init.apiKeySource == null;
  return true;
}

export interface ClaudeAccountSource {
  apiKeySource?: string;
  tokenSource?: string;
  apiProvider?: string;
}

/**
 * Preventive check on Claude Code's `initialize` answer, read BEFORE the first
 * user message is sent (no model request). Only the source fields are looked
 * at (never an e-mail or organisation). Fails closed: no answer, or a missing
 * field the route depends on, means "no" for every route but the user's own
 * subscription.
 */
export function accountAllowed(route: ClaudeRoute, info: ClaudeAccountSource | null | undefined): boolean {
  if (route === 'claude-code') return true;
  if (!info) return false;
  const noToken = !info.tokenSource || info.tokenSource === 'none';
  if (route === 'api-key') return noToken && info.apiKeySource === 'ANTHROPIC_API_KEY' && (info.apiProvider == null || info.apiProvider === 'firstParty');
  const noKey = info.apiKeySource == null || info.apiKeySource === 'none';
  if (route === 'bedrock') return noToken && noKey && (info.apiProvider === 'bedrock' || info.apiProvider === 'anthropicAws');
  if (route === 'vertex') return noToken && noKey && (info.apiProvider === 'vertex' || info.apiProvider === 'anthropicGoogleCloud');
  return false;
}
