import type { AuthStatus, ModelOption, ProviderEvent } from '../../shared/types';
import type { ProviderAdapter, SendRequest } from './types';

/** Visual-only hooks the demo backend may drive (never injects real input). */
export interface DemoEffects {
  pointAtSomething(): void;
  ghostTour(signal: AbortSignal): Promise<void>;
}

const ANSWER = `This is the **Cadabra demo backend** — no AI is connected, so nothing leaves your PC.

Here's what a real answer looks like:

- I can *see* the window you summoned me on
- I can **point** at things with gold rings
- and I can act for you while you watch, with a ghost cursor

\`Esc\` stops me at any time. Pick **Claude**, **Copilot** or **Codex** from the model pill to go live.`;

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((r) => {
    const t = setTimeout(r, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      r();
    });
  });

export class DemoProvider implements ProviderAdapter {
  readonly id = 'demo' as const;
  readonly label = 'Demo';
  constructor(private readonly fx: () => DemoEffects | null) {}

  async listModels(): Promise<ModelOption[]> {
    return [{ id: 'demo-sparkle', label: 'Sparkle (offline)', description: 'Canned responses for previews', default: true }];
  }

  async checkAuth(): Promise<AuthStatus> {
    return { ok: true, detail: 'Offline demo — no account needed' };
  }

  async *send(req: SendRequest): AsyncIterable<ProviderEvent> {
    const s = req.signal;
    yield { type: 'status', text: 'Looking…' };
    yield { type: 'tool', id: 't1', name: 'see_screen', phase: 'start' };
    await sleep(700, s);
    yield { type: 'tool', id: 't1', name: '', phase: 'end', ok: true };
    const wantsAction = /\b(click|do|open|type|press|scroll|show me how)\b/i.test(req.prompt);
    if (wantsAction) {
      yield { type: 'tool', id: 't2', name: 'click', phase: 'start' };
      yield { type: 'status', text: 'On it' };
      await this.fx()?.ghostTour(s);
      yield { type: 'tool', id: 't2', name: '', phase: 'end', ok: true };
    } else {
      yield { type: 'tool', id: 't2', name: 'highlight', phase: 'start' };
      this.fx()?.pointAtSomething();
      yield { type: 'status', text: 'Found it' };
      await sleep(350, s);
      yield { type: 'tool', id: 't2', name: '', phase: 'end', ok: true };
    }
    const words = ANSWER.split(/(\s+)/);
    for (const w of words) {
      if (s.aborted) break;
      yield { type: 'text', delta: w };
      await sleep(w.trim() ? 28 : 0, s);
    }
    yield { type: 'done', sessionId: 'demo' };
  }
}
