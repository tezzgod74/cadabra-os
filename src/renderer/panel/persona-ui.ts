// Round 5: "Choose your assistant" — a name (= the wake word) and a voice,
// grouped by dialect (British / American / Southern). Used by onboarding and
// Settings. Users can mix any name with any voice.
import { checkName, CURATED_NAMES, displayName } from '../../shared/assistant';
import { ALL_VOICES, CLOUD_VOICE_DISCLOSURE, DIALECT_LABEL, PERSONAS, voiceById, type Dialect } from '../../shared/voices';

export interface PersonaApi {
  setSettings(patch: unknown): Promise<any>;
  setSecret?(key: string, value: string | null): Promise<boolean>;
  ttsStatus?(): Promise<any>;
  previewVoice?(voice: string, speed: number): Promise<boolean>;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const DIALECTS: Dialect[] = ['british', 'american', 'southern'];

/** Voice <select> options grouped by dialect (cloud voices marked). */
export function voiceOptions(): string {
  return DIALECTS.map(
    (d) =>
      `<optgroup label="${DIALECT_LABEL[d]}${d === 'southern' ? ' (cloud voice)' : ''}">${ALL_VOICES.filter((v) => v.dialect === d)
        .map((v) => `<option value="${v.id}">${esc(v.label.replace(/ — Southern \(cloud\)$/, ''))} · ${v.gender}</option>`)
        .join('')}</optgroup>`,
  ).join('');
}

// ---------------------------------------------------------------- wake test --

let wakeHook: ((st: string) => void) | null = null;
/** The panel forwards voice states here (for the "Say '<name>, hello'" test). */
export function personaVoiceState(st: string) {
  wakeHook?.(st);
}

/** Listen up to `ms` for the wake word; resolves true when it was heard. */
export function waitForWake(ms = 10_000): Promise<boolean> {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      wakeHook = null;
      resolve(false);
    }, ms);
    wakeHook = (st) => {
      if (st === 'listening' || st === 'transcribing') {
        clearTimeout(t);
        wakeHook = null;
        resolve(true);
      }
    };
  });
}

// ------------------------------------------------------------- name picker --

/** Name select (curated + "Custom…") with validation. Calls onSaved(newSettings). */
export function renderNamePicker(box: HTMLElement, s: any, api: PersonaApi, onSaved: (s: any) => void) {
  const cur = displayName(s.voice.wakeWord);
  const curated = CURATED_NAMES.some((n) => n.name.toLowerCase() === cur.toLowerCase());
  box.innerHTML = `
    <div class="name-pick">
      <select id="pn-select" aria-label="Assistant name">${CURATED_NAMES.map((n) => `<option value="${n.name}">${n.name} · ${n.gender}${n.note ? ` (${n.note.toLowerCase()})` : ''}</option>`).join('')}<option value="__custom">Custom name… (untested)</option></select>
      <input id="pn-custom" class="ob-input" type="text" maxlength="24" placeholder="Type a name" ${curated ? 'hidden' : ''} />
      <button type="button" class="btn ghost" id="pn-save" hidden>Use this name</button>
    </div>
    <p class="ob-hint" id="pn-hint" aria-live="polite"></p>`;
  const sel = box.querySelector<HTMLSelectElement>('#pn-select')!;
  const custom = box.querySelector<HTMLInputElement>('#pn-custom')!;
  const saveBtn = box.querySelector<HTMLButtonElement>('#pn-save')!;
  const hint = box.querySelector<HTMLElement>('#pn-hint')!;
  sel.value = curated ? CURATED_NAMES.find((n) => n.name.toLowerCase() === cur.toLowerCase())!.name : '__custom';
  if (!curated) custom.value = cur;
  const save = async (name: string) => {
    const next = await api.setSettings({ voice: { ...s.voice, wakeWord: name.toLowerCase() } });
    if (next) {
      Object.assign(s, next);
      onSaved(next);
    }
    const curatedName = CURATED_NAMES.some((n) => n.name.toLowerCase() === name.toLowerCase());
    hint.textContent = curatedName ? `Say “${name}” to wake me. (The app is still called Cadabra OS.)` : `Say “${name}” to wake me. Untested name: try “${name}, hello” with the Test button first.`;
    hint.className = curatedName ? 'ob-hint ok' : 'ob-hint warn';
  };
  const validate = () => {
    const r = checkName(custom.value);
    hint.className = `ob-hint ${r.ok ? (r.warnings.length ? 'warn' : 'ok') : 'warn'}`;
    // REVIEW-5 V5-6: custom names never went through the wake-word test matrix.
    hint.textContent = r.ok ? (r.warnings[0] ?? `“${r.name}” is untested as a wake word: use “Test: say ‘${r.name}, hello’” before relying on it.`) : (r.error ?? '');
    saveBtn.disabled = !r.ok;
    return r;
  };
  sel.onchange = () => {
    const isCustom = sel.value === '__custom';
    custom.hidden = !isCustom;
    saveBtn.hidden = !isCustom;
    if (isCustom) {
      custom.focus();
      validate();
    } else void save(sel.value);
  };
  custom.oninput = validate;
  custom.onkeydown = (e) => {
    if (e.key === 'Enter' && validate().ok) saveBtn.click();
  };
  saveBtn.onclick = () => {
    const r = validate();
    if (r.ok) void save(r.name);
  };
  if (!curated) {
    saveBtn.hidden = false;
    validate();
  }
}

// ----------------------------------------------------------- persona cards --

/** The six "Choose your assistant" cards (British / American / Southern × female / male). */
export async function renderPersonaCards(box: HTMLElement, s: any, api: PersonaApi, onChosen: (s: any) => void) {
  const st = await api.ttsStatus?.().catch(() => null);
  const hasKey = !!st?.cloudKey;
  const installed = !!st?.installed;
  const draw = () => {
    const curVoice = s.voice.ttsVoice;
    box.innerHTML = DIALECTS.map((d) => {
      const ps = PERSONAS.filter((p) => p.dialect === d);
      return `<div class="persona-group"><h5>${DIALECT_LABEL[d]}${d === 'southern' ? ' <span class="chip">cloud voice</span>' : ''}</h5><div class="ob-backends">${ps
        .map((p) => {
          const v = voiceById(p.voice);
          const on = curVoice === p.voice;
          const cloud = v.engine === 'openai';
          const needsKey = cloud && !hasKey;
          return `<div class="ob-backend persona${on ? ' on' : ''}" role="radio" aria-checked="${on}" tabindex="0" data-persona="${p.id}">
            <b>${esc(v.label.split(' — ')[0])} <span class="persona-g">· ${DIALECT_LABEL[p.dialect]} ${p.gender} voice</span></b>
            <small>${esc(p.blurb)}</small>
            <div class="persona-btns">${
              needsKey
                ? '<small class="persona-need">Needs an OpenAI API key</small>'
                : `<button type="button" class="btn ghost persona-prev" ${!cloud && !installed ? 'disabled title="Download the natural voice first"' : ''}>Preview</button>`
            }${displayName(s.voice.wakeWord).toLowerCase() === p.name.toLowerCase() ? '' : `<button type="button" class="btn ghost persona-name">Name: ${esc(p.name)}?</button>`}</div>
          </div>`;
        })
        .join('')}</div></div>`;
    }).join('') +
      `<div class="persona-cloud" id="pc-cloud" ${hasKey && s.voice.cloudVoice ? 'hidden' : ''}>
        <p class="s-note">Southern voices aren’t available offline yet, so they use OpenAI’s voice with your own key. ${esc(CLOUD_VOICE_DISCLOSURE)} Without a key (or offline), the American voice of the same gender speaks instead.</p>
        <div class="tts-pick"><input id="pc-key" class="ob-input" type="password" placeholder="sk-… (OpenAI API key)" autocomplete="off" /><button type="button" class="btn ghost" id="pc-save">Save key</button></div>
        <p class="ob-hint" id="pc-hint"></p>
      </div>`;
    box.querySelectorAll<HTMLElement>('.persona').forEach((card) => {
      const p = PERSONAS.find((x) => x.id === card.dataset.persona)!;
      // REVIEW-5 §4: the card picks the VOICE; the name is a separate choice
      // (the suggested name is one click away).
      const choose = async () => {
        const cloud = voiceById(p.voice).engine === 'openai';
        const next = await api.setSettings({ voice: { ...s.voice, ttsVoice: p.voice, ttsEngine: 'kokoro', ...(cloud ? { cloudVoice: true } : {}) } });
        if (next) Object.assign(s, next);
        onChosen(s);
        draw();
      };
      const useName = card.querySelector<HTMLButtonElement>('.persona-name');
      if (useName)
        useName.onclick = async () => {
          const next = await api.setSettings({ voice: { ...s.voice, wakeWord: p.name.toLowerCase() } });
          if (next) Object.assign(s, next);
          onChosen(s);
          draw();
        };
      card.onclick = (e) => {
        if ((e.target as HTMLElement).closest('.persona-prev, .persona-name')) return;
        void choose();
      };
      card.onkeydown = (e) => {
        if (e.key === 'Enter' || e.key === ' ') void choose();
      };
      const prev = card.querySelector<HTMLButtonElement>('.persona-prev');
      if (prev)
        prev.onclick = async () => {
          prev.disabled = true;
          await api.previewVoice?.(p.voice, s.voice.ttsSpeed ?? 1.05).catch(() => undefined);
          prev.disabled = false;
        };
    });
    const keyIn = box.querySelector<HTMLInputElement>('#pc-key');
    const keySave = box.querySelector<HTMLButtonElement>('#pc-save');
    if (keyIn && keySave)
      keySave.onclick = async () => {
        const k = keyIn.value.trim();
        const hint = box.querySelector<HTMLElement>('#pc-hint')!;
        if (!/^sk-[A-Za-z0-9_-]{16,}$/.test(k)) {
          hint.textContent = 'That doesn’t look like an OpenAI API key (sk-…).';
          hint.className = 'ob-hint warn';
          return;
        }
        await api.setSecret?.('openaiApiKey', k);
        keyIn.value = '';
        const next = await api.setSettings({ voice: { ...s.voice, cloudVoice: true } });
        if (next) Object.assign(s, next);
        hint.textContent = 'Saved (encrypted with Windows). Southern voices are on.';
        hint.className = 'ob-hint ok';
        setTimeout(() => void renderPersonaCards(box, s, api, onChosen), 600);
      };
  };
  draw();
}
