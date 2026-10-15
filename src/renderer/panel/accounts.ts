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
  claude: 'Two ways to use Claude, both through Anthropic’s Claude Code app: your Claude subscription (no extra cost; Anthropic’s terms may restrict third-party use, at your own risk), or an API key billed per use.',
  copilot: 'Sign in by running <code>copilot</code> in a terminal and typing <code>/login</code>.',
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function statusChip(v: Pick<AccountView, 'auth'>): string {
  return `<span class="chip ${v.auth.ok ? 'ok' : 'off'}"><span class="chip-dot"></span>${v.auth.ok ? 'Connected' : 'Not connected'}<span class="chip-detail"> · ${esc(v.auth.detail)}</span></span>`;
}

/** Render the account card for one backend into `el`. Calls `onChange` after a successful connect. */
export async function renderAccount(el: HTMLElement, api: AccountApi, provider: string, onChange?: (v: AccountView) => void): Promise<void> {
  /** Claude's guided setup: where the one-click install is (round 13). */
  let install: { state: 'idle' | 'consent' | 'running' | 'failed'; error?: string } = { state: 'idle' };

  el.innerHTML = `<div class="acct loading"><span class="status-orb"></span> Checking ${esc(provider)}…</div>`;
  const view = await api.accountOptions(provider);
  if (!view) {
    el.innerHTML = '';
    return;
  }
  draw(view);

  function draw(v: AccountView, progress = '') {
    if (v.id === 'claude') {
      drawClaude(v, progress);
      return;
    }
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

  // ---------------------------------------------------------------------------
  // Claude: a friendly three-step setup for people who have never heard of
  // Claude Code. 1. get the Claude Code app (one click, or by hand), 2. connect
  // (sign in with a Claude plan, or paste an API key), 3. test. No jargon.
  function drawClaude(v: AccountView, progress = '') {
    const installed = v.install?.installed !== false;
    const connected = installed && v.auth.ok;
    const sub = v.options.find((o) => o.id === 'claude-code');
    const key = v.options.find((o) => o.id === 'api-key');
    const more = v.options.filter((o) => o.id !== 'claude-code' && o.id !== 'api-key');
    const i = v.install;
    const stepCls = (n: number) => {
      const cur = !installed ? 1 : !connected ? 2 : 3;
      return n < cur ? 'done' : n === cur ? 'current' : 'later';
    };
    const step1 = installed
      ? `<p class="cl-ok">Claude Code is installed on this PC.</p>`
      : `<p class="cl-what">Claude Code is Anthropic’s free app that lets Cadabra talk to Claude. It isn’t part of Cadabra, so it’s installed once, separately. It takes about a minute.</p>
        ${
          i?.blocker
            ? `<p class="acct-err">${esc(i.blocker)}</p>`
            : install.state === 'consent'
              ? `<div class="cl-consent" role="alertdialog" aria-label="Install Claude Code?">
                  <p>Cadabra will run Anthropic’s official installer for your Windows account. You don’t need to be an administrator. This is exactly what will run:</p>
                  <pre class="c-mono">${esc(i?.command ?? '')}</pre>
                  <div class="ob-nav-r"><button type="button" class="btn ghost cl-cancel">Cancel</button><button type="button" class="btn primary cl-run">Install</button></div>
                </div>`
              : install.state === 'running'
                ? `<div class="ob-progress cl-running"><div class="bar indeterminate"><span></span></div><small>Installing Claude Code… this usually takes about a minute.</small></div>`
                : `${install.state === 'failed' ? `<p class="acct-err" role="alert">${esc(install.error ?? 'The install didn’t finish.')}</p>` : ''}
                   <button type="button" class="btn primary cl-install">${install.state === 'failed' ? 'Try again' : 'Install Claude Code'}</button>`
        }
        <details class="inst-manual cl-manual"${install.state === 'failed' ? ' open' : ''}><summary>Install it yourself instead</summary>
          <ol class="cl-howto">
            <li>Click <b>Start</b>, type <b>PowerShell</b> and open <b>Windows PowerShell</b>.</li>
            <li>Copy this line, paste it into that window and press <b>Enter</b>:
              <div class="inst-line"><code>${esc(i?.command ?? '')}</code><button type="button" class="btn ghost inst-copy" data-cmd="${esc(i?.command ?? '')}">Copy</button></div></li>
            <li>When it says Claude Code is installed, come back here and press <b>Check again</b>.</li>
          </ol>
          <div class="inst-line"><button type="button" class="btn ghost cl-recheck">Check again</button>${i?.docsUrl ? `<a class="inst-docs" href="${esc(i.docsUrl)}">Anthropic’s install page</a>` : ''}</div>
          <div class="inst-line"><span>Already installed somewhere else?</span><button type="button" class="btn ghost inst-browse">Find it on my PC…</button></div>
        </details>`;
    const optRow = (o: SignInOptionView | undefined, body: string) =>
      o ? `<div class="acct-opt cl-choice${v.active === o.id ? ' active' : ''}" data-opt="${esc(o.id)}"><div class="acct-opt-main">${body}</div></div>` : '';
    const step2 = !installed
      ? `<p class="cl-later">Available after step 1.</p>`
      : `${v.error ? `<p class="acct-err" role="alert">${esc(v.error)}</p>` : !v.auth.ok && v.auth.howTo ? `<p class="acct-how">${esc(v.auth.howTo)}</p>` : ''}
        ${optRow(
          sub,
          `<span class="acct-opt-label">Use my Claude subscription</span>
           <small>If you pay for Claude (Pro or Max), sign in with that account. No extra cost. Anthropic’s terms may restrict using a subscription through other apps, so this is at your own risk.</small>
           <button type="button" class="btn primary acct-go">${v.active === 'claude-code' && v.auth.ok ? 'Sign in again' : 'Sign in'}</button>`,
        )}
        ${optRow(
          key,
          `<span class="acct-opt-label">Use an Anthropic API key</span>
           <small>You pay Anthropic for what you use, separately from any Claude subscription. Create a key on Anthropic’s website, then paste it here. It’s stored encrypted on this PC.</small>
           <a class="inst-docs cl-keylink" href="https://console.anthropic.com/settings/keys">Get a key at console.anthropic.com</a>
           <input type="password" class="acct-key" placeholder="Paste your API key (sk-ant-…)" aria-label="Your Anthropic API key" />
           <button type="button" class="btn ghost acct-go">Save key</button>`,
        )}
        ${
          more.length
            ? `<details class="inst-manual"><summary>Other ways (Amazon Bedrock, Google Vertex AI)</summary>${more
                .map((o) => optRow(o, `<span class="acct-opt-label">${esc(o.label)}</span>${o.note ? `<small>${esc(o.note)}</small>` : ''}<button type="button" class="btn ghost acct-go">${v.active === o.id ? 'Reconnect' : 'Connect'}</button>`))
                .join('')}</details>`
            : ''
        }`;
    const step3 = connected
      ? `<p class="cl-what">Send Claude a tiny test message to make sure everything works.</p>
         <div class="acct-actions"><button type="button" class="btn primary acct-test">Test</button>${v.canSignOut ? '<button type="button" class="btn ghost acct-out">Sign out</button>' : ''}</div>`
      : `<p class="cl-later">Available after step 2.</p>`;
    el.innerHTML = `
      <div class="acct cl-setup" data-provider="claude">
        <div class="acct-head"><b>${esc(v.label)}</b>${statusChip(v)}</div>
        <ol class="cl-steps">
          <li class="cl-step ${stepCls(1)}"><h4><span class="cl-num">1</span>Get the Claude Code app</h4>${step1}</li>
          <li class="cl-step ${stepCls(2)}"><h4><span class="cl-num">2</span>Connect your Claude account</h4>${step2}</li>
          <li class="cl-step ${stepCls(3)}"><h4><span class="cl-num">3</span>Test it</h4>${step3}</li>
        </ol>
        <div class="acct-progress" aria-live="polite">${esc(progress)}</div>
      </div>`;
    const q = <T extends Element>(sel: string) => el.querySelector<T>(sel);
    q<HTMLButtonElement>('.cl-install')?.addEventListener('click', () => {
      install = { state: 'consent' };
      drawClaude(v);
    });
    q<HTMLButtonElement>('.cl-cancel')?.addEventListener('click', () => {
      install = { state: 'idle' };
      drawClaude(v);
    });
    q<HTMLButtonElement>('.cl-run')?.addEventListener('click', async () => {
      install = { state: 'running' };
      drawClaude(v);
      const r = await api.installCli(v.id);
      if (r?.ok && r.view) {
        install = { state: 'idle' };
        draw(r.view, r.view.install?.installed === false ? '' : 'Claude Code is installed. Now connect your account.');
        return;
      }
      install = { state: 'failed', error: r?.error ? `The install didn’t finish: ${r.error}` : 'The install didn’t finish.' };
      drawClaude(r?.view ?? v);
    });
    q<HTMLButtonElement>('.cl-recheck')?.addEventListener('click', async () => {
      setProgress('Checking…');
      const next = await api.accountOptions(v.id);
      if (next) draw(next, next.install?.installed === false ? 'Claude Code isn’t installed yet.' : 'Found it.');
    });
    el.querySelectorAll<HTMLButtonElement>('.inst-copy').forEach((b) =>
      b.addEventListener('click', () => {
        void navigator.clipboard?.writeText(b.dataset.cmd ?? '');
        b.textContent = 'Copied';
      }),
    );
    q<HTMLButtonElement>('.inst-browse')?.addEventListener('click', async () => {
      const next = await api.browseCli?.(v.id);
      if (next) draw(next, next.install?.installed ? 'Found it.' : '');
    });
    el.querySelectorAll<HTMLAnchorElement>('a.inst-docs').forEach((a) =>
      a.addEventListener('click', (e) => {
        e.preventDefault();
        api.openExternal(a.href);
      }),
    );
    el.querySelectorAll<HTMLElement>('.cl-choice').forEach((row) => {
      const go = row.querySelector<HTMLButtonElement>('.acct-go')!;
      const keyIn = row.querySelector<HTMLInputElement>('.acct-key');
      go.onclick = async () => {
        const opt = row.dataset.opt!;
        if (keyIn && !keyIn.value.trim()) {
          keyIn.focus();
          setProgress('Paste your API key first.', true);
          return;
        }
        el.querySelectorAll<HTMLButtonElement>('button').forEach((b) => (b.disabled = true));
        setProgress(keyIn ? 'Saving your key…' : opt === 'claude-code' ? 'Opening Claude Code’s sign-in… finish it in the window that opens.' : 'Connecting…');
        const next = await api.signIn(v.id, opt, keyIn ? keyIn.value.trim() : null);
        if (keyIn) keyIn.value = '';
        if (next) {
          draw(next, next.auth.ok ? 'Connected. Last step: press Test.' : '');
          if (next.auth.ok) onChange?.(next);
        }
      };
      keyIn?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') go.click();
      });
    });
    q<HTMLButtonElement>('.acct-test')?.addEventListener('click', async () => {
      setProgress('Sending Claude a tiny test message…');
      const r = await api.testProvider(v.id);
      setProgress(r?.ok ? `It works! Claude answered: “${r.text || 'Ready'}”` : `That didn’t work: ${r?.error ?? 'no answer'}`, !r?.ok);
    });
    q<HTMLButtonElement>('.acct-out')?.addEventListener('click', async () => {
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
