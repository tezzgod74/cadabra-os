// Account / sign-in UI shared by Settings and onboarding (Priority 2).
// Honest labels only, no vendor logos: every vendor login runs in the vendor's
// own flow (their CLI opens their page in your browser).

export interface SignInOptionView {
  id: string;
  label: string;
  note?: string;
  needsKey?: boolean;
  keyPlaceholder?: string;
}

export interface AccountView {
  id: string;
  label: string;
  auth: { ok: boolean; detail: string; howTo?: string };
  options: SignInOptionView[];
  active?: string;
  canSignOut?: boolean;
  error?: string;
  /** Part B: the vendor CLI isn't installed: exact official command + manual steps. */
  install?: { installed: boolean; name?: string; command?: string; manual?: string[]; docsUrl?: string; blocker?: string | null };
}

export interface AccountApi {
  accountOptions(provider: string): Promise<AccountView | null>;
  signIn(provider: string, optionId: string, key: string | null): Promise<AccountView | null>;
  signOut(provider: string): Promise<AccountView | null>;
  testProvider(provider: string): Promise<{ ok: boolean; text?: string; error?: string } | null>;
  installCli(provider: string): Promise<{ ok: boolean; error?: string; view?: AccountView } | null>;
  browseCli?(provider: string): Promise<AccountView | null>;
  openExternal(url: string): void;
}

export const BACKEND_BLURB: Record<string, string> = {
  claude: 'Anthropic’s Claude: your Claude plan via Claude Code, or an API key.',
  codex: 'OpenAI via the Codex CLI. Sign in with ChatGPT or use an OpenAI API key.',
  gemini: 'Google Gemini via the Gemini CLI. Sign in with Google or use a Gemini API key.',
  copilot: 'GitHub Copilot via the Copilot CLI and your Copilot plan.',
  demo: 'Offline demo. No account, canned answers, great for a tour.',
};

export const ACCOUNT_NOTES: Record<string, string> = {
  claude: 'Two ways to use Claude: your Claude subscription through the official Claude Code CLI (no extra cost; Anthropic’s terms may restrict third-party use, at your own risk), or an API key billed per use.',
  copilot: 'Sign in by running <code>copilot</code> in a terminal and typing <code>/login</code>.',
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function statusChip(v: Pick<AccountView, 'auth'>): string {
  return `<span class="chip ${v.auth.ok ? 'ok' : 'off'}"><span class="chip-dot"></span>${v.auth.ok ? 'Connected' : 'Not connected'}<span class="chip-detail"> · ${esc(v.auth.detail)}</span></span>`;
}

/** Render the account card for one backend into `el`. Calls `onChange` after a successful connect. */
export async function renderAccount(el: HTMLElement, api: AccountApi, provider: string, onChange?: (v: AccountView) => void): Promise<void> {
  el.innerHTML = `<div class="acct loading"><span class="status-orb"></span> Checking ${esc(provider)}…</div>`;
  const view = await api.accountOptions(provider);
  if (!view) {
    el.innerHTML = '';
    return;
  }
  draw(view);

  function draw(v: AccountView, progress = '') {
    const note = ACCOUNT_NOTES[v.id];
    el.innerHTML = `
      <div class="acct" data-provider="${esc(v.id)}">
        <div class="acct-head"><b>${esc(v.label)}</b>${statusChip(v)}</div>
        ${v.error ? `<p class="acct-err" role="alert">${esc(v.error)}</p>` : !v.auth.ok && v.auth.howTo && v.install?.installed !== false ? `<p class="acct-how">${esc(v.auth.howTo)}</p>` : ''}
        ${installBlock(v)}
        <div class="acct-opts">
          ${v.options
            .map(
              (o) => `<div class="acct-opt${v.active === o.id ? ' active' : ''}" data-opt="${esc(o.id)}">
                <div class="acct-opt-main"><span class="acct-opt-label">${esc(o.label)}</span>${o.note ? `<small>${esc(o.note)}</small>` : ''}
                ${
                  o.needsKey && v.install && !v.install.installed
                    ? // REVIEW-4: no key field next to "Install first"; say why instead.
                      `<small class="acct-after">You can add your key once ${esc(v.install.name ?? 'the CLI')} is installed.</small>`
                    : o.needsKey
                      ? `<input type="password" class="acct-key" placeholder="${esc(o.keyPlaceholder ?? 'Paste key')}" aria-label="${esc(o.label)}" />`
                      : ''
                }</div>
                ${
                  v.install && !v.install.installed
                    ? // REVIEW-3 UX-R: one primary action when the CLI is missing: Install.
                      `<button type="button" class="btn ghost acct-go" disabled title="Install ${esc(v.install.name ?? 'the CLI')} first">Install first</button>`
                    : `<button type="button" class="btn ${o.needsKey ? 'ghost' : 'primary'} acct-go">${goLabel(v, o.id, !!o.needsKey)}</button>`
                }
              </div>`,
            )
            .join('')}
        </div>
        ${note ? `<p class="s-note">${note}</p>` : ''}
        <div class="acct-progress" aria-live="polite">${esc(progress)}</div>
        <div class="acct-actions">
          ${v.auth.ok ? '<button type="button" class="btn ghost acct-test">Test connection</button>' : ''}
          ${v.auth.ok && v.canSignOut ? '<button type="button" class="btn ghost acct-out">Sign out</button>' : ''}
        </div>
      </div>`;
    el.querySelectorAll<HTMLElement>('.acct-opt').forEach((row) => {
      const go = row.querySelector<HTMLButtonElement>('.acct-go')!;
      const key = row.querySelector<HTMLInputElement>('.acct-key');
      go.onclick = async () => {
        const opt = row.dataset.opt!;
        if (key && !key.value.trim()) {
          key.focus();
          return;
        }
        el.querySelectorAll<HTMLButtonElement>('button').forEach((b) => (b.disabled = true));
        setProgress(key ? 'Saving…' : 'Opening the sign-in page in your browser…');
        const next = await api.signIn(v.id, opt, key ? key.value.trim() : null);
        if (key) key.value = '';
        if (next) {
          draw(next, next.auth.ok ? 'Connected.' : '');
          if (next.auth.ok) onChange?.(next);
        }
      };
      key?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') go.click();
      });
    });
    // Part B: install the official CLI, only after the user saw the exact command.
    const inst = el.querySelector<HTMLElement>('.acct-install');
    inst?.querySelector<HTMLButtonElement>('.inst-go')?.addEventListener('click', () => {
      inst.classList.add('consent');
    });
    inst?.querySelector<HTMLButtonElement>('.inst-cancel')?.addEventListener('click', () => inst.classList.remove('consent'));
    inst?.querySelector<HTMLButtonElement>('.inst-run')?.addEventListener('click', async () => {
      inst.classList.remove('consent');
      inst.classList.add('running');
      el.querySelectorAll<HTMLButtonElement>('button').forEach((b) => (b.disabled = true));
      setProgress('Installing…');
      const r = await api.installCli(v.id);
      if (r?.view) draw(r.view, r.ok ? 'Installed. Now choose how to connect.' : '');
      if (r && !r.ok) setProgress(`Install failed: ${r.error ?? 'unknown error'}`, true);
    });
    inst?.querySelectorAll<HTMLButtonElement>('.inst-copy').forEach((b) =>
      b.addEventListener('click', () => {
        void navigator.clipboard?.writeText(b.dataset.cmd ?? '');
        b.textContent = 'Copied';
      }),
    );
    inst?.querySelector<HTMLButtonElement>('.inst-browse')?.addEventListener('click', async () => {
      const next = await api.browseCli?.(v.id);
      if (next) draw(next, next.install?.installed ? 'Found it.' : '');
    });
    inst?.querySelector<HTMLAnchorElement>('.inst-docs')?.addEventListener('click', (e) => {
      e.preventDefault();
      api.openExternal((e.currentTarget as HTMLAnchorElement).href);
    });
    el.querySelector<HTMLButtonElement>('.acct-test')?.addEventListener('click', async () => {
      setProgress('Sending a tiny test request…');
      const r = await api.testProvider(v.id);
      setProgress(r?.ok ? `Works! It answered: “${r.text || 'Ready'}”` : `Test failed: ${r?.error ?? 'no answer'}`, !r?.ok);
    });
    el.querySelector<HTMLButtonElement>('.acct-out')?.addEventListener('click', async () => {
      const next = await api.signOut(v.id);
      if (next) draw(next, 'Signed out.');
    });
  }

  function setProgress(text: string, bad = false) {
    const p = el.querySelector<HTMLElement>('.acct-progress');
    if (!p) return;
    p.textContent = text;
    p.classList.toggle('bad', bad);
  }
}

/** Live progress pushed from main while a vendor flow runs. */
export function showAccountStatus(root: ParentNode, provider: string, text: string) {
  const p = root.querySelector<HTMLElement>(`.acct[data-provider="${CSS.escape(provider)}"] .acct-progress`);
  if (p) p.textContent = text;
}

function goLabel(v: AccountView, id: string, needsKey: boolean): string {
  if (needsKey) return 'Save';
  if (id === 'claude-code') return v.active === id ? 'Reconnect' : 'Use my subscription';
  return v.active === id ? 'Reconnect' : 'Connect';
}

/** Part B: "Install <CLI>" with the exact command, consent step, manual fallback. */
function installBlock(v: AccountView): string {
  const i = v.install;
  if (!i || i.installed) return '';
  const name = esc(i.name ?? 'the CLI');
  return `<div class="acct-install">
    <div class="inst-head"><b>${name} isn’t installed</b><small>Cadabra uses the vendor’s official, unmodified CLI on your PC.</small></div>
    ${i.blocker ? `<p class="acct-err">${esc(i.blocker)}</p>` : `<button type="button" class="btn primary inst-go">Install ${name}</button>`}
    <div class="inst-consent" role="alertdialog" aria-label="Run the official installer?">
      <p>Cadabra will run this official command for your user account (no admin):</p>
      <pre class="c-mono">${esc(i.command ?? '')}</pre>
      <div class="ob-nav-r"><button type="button" class="btn ghost inst-cancel">Cancel</button><button type="button" class="btn primary inst-run">Run it</button></div>
    </div>
    <details class="inst-manual"><summary>Install it yourself</summary>
      ${(i.manual ?? []).map((m) => `<div class="inst-line"><code>${esc(m)}</code><button type="button" class="btn ghost inst-copy" data-cmd="${esc(m)}">Copy</button></div>`).join('')}
      ${i.docsUrl ? `<a class="inst-docs" href="${esc(i.docsUrl)}">Official install guide</a>` : ''}
      <div class="inst-line"><span>Already installed somewhere else?</span><button type="button" class="btn ghost inst-browse">Browse…</button></div>
    </details>
  </div>`;
}
