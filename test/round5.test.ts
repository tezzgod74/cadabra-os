// Round 5: assistant name / wake word, personas and dialects, cloud (Southern)
// voice with a fake endpoint, response speed and cadence.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { checkName, CURATED_NAMES, displayName, matchWake, RESERVED_NAMES, syllables } from '../src/shared/assistant';
import { keywordsFileFor, tokenizePhrase, tokenizeWordNBest, type Scores } from '../src/shared/kws-tokens';
import { ALL_VOICES, CLOUD_VOICE_DISCLOSURE, offlineFallback, PERSONAS, SOUTHERN_INSTRUCTIONS, voiceById, DEFAULT_SPEED } from '../src/shared/voices';
import { mergeSettings } from '../src/shared/settings';
import { SentenceStreamer } from '../src/shared/speech';
import { personaContext } from '../src/shared/persona';
import { toSpokenText } from '../src/shared/spoken-text';
import { shapeChunk } from '../src/main/voice/tts-shape';
import { findId2Speaker, parseId2Speaker } from '../src/main/voice/kokoro-meta';
import { CloudTts, pcm16ToFloat, PCM_RATE } from '../src/main/voice/openai-tts';

const scores = JSON.parse(fs.readFileSync(path.resolve('resources/models/kws/scores.json'), 'utf8')) as Scores;

describe('wake-word tokenizer (SentencePiece unigram, from the model)', () => {
  it("reproduces sherpa's own keyword examples and Cadabra's original line", () => {
    expect(tokenizePhrase('hello world', scores)?.join(' ')).toBe('▁HE LL O ▁WORLD');
    expect(tokenizePhrase('hi google', scores)?.join(' ')).toBe('▁HI ▁GO O G LE');
    expect(tokenizePhrase('hey siri', scores)?.join(' ')).toBe('▁HE Y ▁S I RI');
    expect(tokenizePhrase('alexa', scores)?.join(' ')).toBe('▁A LE X A');
    expect(tokenizePhrase('cadabra', scores)?.join(' ')).toBe('▁CA D A B RA');
  });
  it('n-best gives alternative paths, best first', () => {
    const nb = tokenizeWordNBest('kestrel', scores, 3);
    expect(nb.length).toBe(3);
    expect(nb[0].join(' ')).toBe(tokenizePhrase('kestrel', scores)!.join(' '));
    expect(new Set(nb.map((p) => p.join(' '))).size).toBe(3);
  });
  it('builds a keywords file: name lines share one label; decoys get their own', () => {
    const f = keywordsFileFor('Cadabra', 0.5, scores, ['Abracadabra'], { paths: 2 });
    const lines = f.trim().split('\n');
    expect(lines.filter((l) => l.endsWith('@CADABRA')).length).toBe(2);
    expect(lines.some((l) => l.endsWith('@ABRACADABRA'))).toBe(true);
    expect(lines[0]).toMatch(/^▁CA D A B RA :2\.0 #0\.18 @CADABRA$/);
  });
  it('every curated name tokenizes and has a decoy', () => {
    for (const n of CURATED_NAMES) {
      expect(tokenizePhrase(n.name, scores), n.name).not.toBeNull();
      expect(n.decoys.length, n.name).toBeGreaterThan(0);
    }
  });
});

describe('assistant names', () => {
  it('curated: 2–3 syllables, mixed genders, no other assistant’s name, Cadabra kept', () => {
    expect(CURATED_NAMES.some((n) => n.name === 'Cadabra')).toBe(true);
    for (const n of CURATED_NAMES) {
      expect(syllables(n.name), n.name).toBeGreaterThanOrEqual(2);
      expect(syllables(n.name), n.name).toBeLessThanOrEqual(3);
      expect(RESERVED_NAMES).not.toContain(n.name.toLowerCase());
    }
    expect(new Set(CURATED_NAMES.map((n) => n.gender))).toEqual(new Set(['masculine', 'feminine', 'neutral']));
  });
  it('custom names are validated', () => {
    expect(checkName('Alexa').ok).toBe(false);
    expect(checkName('Jarvis').ok).toBe(false);
    expect(checkName('Bob').error).toMatch(/Too short/);
    expect(checkName('R2-D2').error).toMatch(/Letters only/);
    expect(checkName('Supercalifragilistic').error).toMatch(/long/);
    expect(checkName('banana').warnings[0]).toMatch(/everyday word/);
    expect(checkName('zephyrine')).toMatchObject({ ok: true, name: 'Zephyrine', warnings: [] });
    expect(displayName('juniper')).toBe('Juniper');
  });
  it('second-stage check tolerates ASR spellings, rejects other words', () => {
    expect(matchWake('Kadaborra, what time is it', 'Cadabra')).toEqual({ request: 'what time is it' });
    expect(matchWake('Auto line, what time is it', 'Ottoline')).toEqual({ request: 'what time is it' });
    expect(matchWake('Hey Rosaland. Are you there?', 'Rosalind')).toEqual({ request: 'Are you there?' });
    expect(matchWake('Lyysander, open the calculator', 'Lysander')?.request).toBe('open the calculator');
    expect(matchWake('Roses are lined up', 'Rosalind')).toBeNull();
    expect(matchWake('Put the kettle on', 'Kestrel')).toBeNull();
  });
});

describe('personas and dialects (research §9)', () => {
  it('six personas: British / American / Southern × female / male', () => {
    expect(PERSONAS.length).toBe(6);
    for (const d of ['british', 'american', 'southern'] as const)
      for (const g of ['female', 'male'] as const) expect(PERSONAS.some((p) => p.dialect === d && p.gender === g), `${d} ${g}`).toBe(true);
    for (const p of PERSONAS) {
      expect(voiceById(p.voice).id).toBe(p.voice);
      expect(voiceById(p.voice).gender).toBe(p.gender);
      expect(checkName(p.name).ok, p.name).toBe(true);
    }
    expect(PERSONAS.find((p) => p.id === 'british-female')!.voice).toBe('bf_emma');
    expect(PERSONAS.find((p) => p.id === 'british-male')!.voice).toBe('bm_george');
    expect(PERSONAS.find((p) => p.id === 'american-female')!.voice).toBe('af_heart');
    expect(PERSONAS.find((p) => p.id === 'american-male')!.voice).toBe('am_michael');
  });
  it('Southern voices are cloud (marin / cedar) and fall back to the American voice of the same gender', () => {
    expect(voiceById('openai_marin')).toMatchObject({ engine: 'openai', openaiVoice: 'marin', gender: 'female', dialect: 'southern' });
    expect(offlineFallback(voiceById('openai_marin')).id).toBe('af_heart');
    expect(offlineFallback(voiceById('openai_cedar')).id).toBe('am_michael');
    expect(CLOUD_VOICE_DISCLOSURE).toMatch(/AI-generated/);
    expect(SOUTHERN_INSTRUCTIONS).toMatch(/Southern American accent/);
  });
  it('dialect phrasing: British spelling rule, Southern touches, nothing for American; name in context', () => {
    expect(personaContext({ wakeWord: 'cadabra', ttsVoice: 'bm_george', phrasing: false })).toBe('');
    expect(personaContext({ wakeWord: 'cadabra', ttsVoice: 'bf_emma', phrasing: true })).toMatch(/British spelling/);
    expect(personaContext({ wakeWord: 'cadabra', ttsVoice: 'openai_cedar', phrasing: true })).toMatch(/Howdy.*never in code/i);
    expect(personaContext({ wakeWord: 'cadabra', ttsVoice: 'af_heart', phrasing: true })).toBe('');
    expect(personaContext({ wakeWord: 'octavia', ttsVoice: 'af_heart', phrasing: false })).toMatch(/Your name is Octavia/);
  });
  it('American and British wording', () => {
    expect(toSpokenText('Battery at 80%', 'american')).toBe('Battery at 80 percent');
    expect(toSpokenText('Battery at 80%', 'british')).toBe('Battery at 80 per cent');
  });
  it('Kokoro speaker ids are read from the model metadata', () => {
    expect(parseId2Speaker('0->af_alloy,3->af_heart,26->bm_george').get('bm_george')).toBe(26);
    const meta = Buffer.concat([Buffer.from('xxid2speaker'), Buffer.from([0x12, 19]), Buffer.from('3->af_heart,21->bf_emma'.slice(0, 19))]);
    expect(findId2Speaker(meta).get('af_heart')).toBe(3);
  });
  it('settings: pace migrates 0.95 → 1.05 once; cloud voice ids and new toggles persist', () => {
    const old = mergeSettings({ version: 1, voice: { ttsSpeed: 0.95, ttsVoice: 'openai_marin', cloudVoice: true, wakeWord: 'Octavia' } });
    expect(old.voice.ttsSpeed).toBe(DEFAULT_SPEED);
    expect(old.voice.ttsVoice).toBe('openai_marin');
    expect(old.voice.cloudVoice).toBe(true);
    expect(old.voice.wakeWord).toBe('octavia');
    expect(mergeSettings({ version: 2, voice: { ttsSpeed: 0.95 } }).voice.ttsSpeed).toBe(0.95);
    expect(mergeSettings({ voice: { wakeWord: 'Alexa' } }).voice.wakeWord).toBe('cadabra');
    expect(mergeSettings({}).voice).toMatchObject({ phrasing: false, cloudVoice: false, fastModelForVoice: true });
    expect(ALL_VOICES.length).toBeGreaterThan(10);
  });
});

describe('response speed and cadence', () => {
  it('speaks the first sentence as soon as it is complete (streaming)', () => {
    const s = new SentenceStreamer(2, 320);
    expect(s.push('8.8.8.8 resolves to ')).toEqual([]);
    expect(s.push('dns.google, which is Google’s DNS. Any')).toEqual(['8.8.8.8 resolves to dns.google, which is Google’s DNS.']);
    expect(s.push('thing else? More text that won’t be spoken. ')).toEqual(['Anything else?']);
    expect(s.flush()).toEqual([]);
  });
  it('no tiny fragments; code is not read out', () => {
    const s = new SentenceStreamer(3, 400);
    expect(s.push('Sure. ')).toEqual([]);
    expect(s.push('Here is the command:\n```\nnslookup 8.8.8.8\n')).toEqual([]);
    expect(s.push('```\nIt looks up the address. ')).toEqual(['Sure. Here is the command.', '(details are in the panel).', 'It looks up the address.']);
    expect(s.flush()).toEqual([]);
  });
  it('a long first sentence is split at a clause boundary so audio starts sooner', async () => {
    const { splitFirstClause } = await import('../src/shared/speech');
    expect(splitFirstClause('This is the Cadabra demo backend, no AI is connected, so nothing leaves your PC.')).toEqual(['This is the Cadabra demo backend,', 'no AI is connected, so nothing leaves your PC.']);
    expect(splitFirstClause('Short one, fine.')).toBeNull();
    const st = new SentenceStreamer(2, 400);
    expect(st.push('This is the Cadabra demo backend, no AI is connected, so nothing leaves your PC. Next one here please. ')).toEqual([
      'This is the Cadabra demo backend,',
      'no AI is connected, so nothing leaves your PC.',
      'Next one here please.',
    ]);
  });
  it('shapes chunks: trims padding, fades edges, adds the sentence pause', () => {
    const rate = 24000;
    const pad = new Float32Array(rate * 0.3);
    const body = new Float32Array(rate * 0.5).fill(0.5);
    const raw = new Float32Array(pad.length * 2 + body.length);
    raw.set(body, pad.length);
    const out = shapeChunk(raw, rate, { pauseMs: 140 });
    expect(out.length).toBeLessThan(raw.length);
    expect(out[0]).toBe(0);
    expect(Math.abs(out.length - (body.length + 2 * 0.04 * rate + 0.14 * rate))).toBeLessThan(4);
  });
});

describe('Southern cloud voice (fake endpoint; never calls OpenAI)', () => {
  function fakeFetch(seen: any[], opts: { fail?: boolean } = {}) {
    return (async (url: string, init: any) => {
      seen.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization });
      if (opts.fail) return { ok: false, status: 401, body: null } as any;
      const pcm = new Uint8Array(PCM_RATE); // 0.5 s of 16-bit silence + a sample
      pcm[0] = 0xff;
      pcm[1] = 0x7f;
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(pcm.slice(0, 7)); // odd split: the carry logic must cope
          c.enqueue(pcm.slice(7));
          c.close();
        },
      });
      return { ok: true, status: 200, body: stream } as any;
    }) as unknown as typeof fetch;
  }
  it('streams PCM per sentence with the accent instruction and the user’s key', async () => {
    const seen: any[] = [];
    const tts = new CloudTts({ key: () => 'sk-test-0123456789abcdef', fetchImpl: fakeFetch(seen), baseUrl: 'http://fake' });
    const chunks: any[] = [];
    tts.on('chunk', (c) => chunks.push(c));
    const done = new Promise((r) => tts.on('done', r));
    const id = tts.speak(['Howdy.'], voiceById('openai_marin'), 1.05, true);
    tts.append(id, ['Anything else?']);
    tts.end(id);
    await done;
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ url: 'http://fake/audio/speech', auth: 'Bearer sk-test-0123456789abcdef' });
    expect(seen[0].body).toMatchObject({ model: 'gpt-4o-mini-tts', voice: 'marin', response_format: 'pcm', input: 'Howdy.' });
    expect(seen[0].body.instructions).toBe(SOUTHERN_INSTRUCTIONS);
    expect(chunks.at(-1).last).toBe(true);
    expect(chunks[0].sampleRate).toBe(PCM_RATE);
    expect(chunks[0].samples[0]).toBeCloseTo(32767 / 32768, 4);
  });
  it('errors report what is left so the offline voice can finish (and never echo the key)', async () => {
    const tts = new CloudTts({ key: () => 'sk-test-0123456789abcdef', fetchImpl: fakeFetch([], { fail: true }), baseUrl: 'http://fake' });
    const err = new Promise<any[]>((r) => tts.on('error', (...a) => r(a)));
    tts.speak(['One.', 'Two.'], voiceById('openai_cedar'), 1, false);
    const [e, , rest] = await err;
    expect(e.message).toMatch(/HTTP 401/);
    expect(e.message).not.toMatch(/sk-test/);
    expect(rest.remaining).toEqual(['One.', 'Two.']);
  });
  it('no key → error, nothing sent', async () => {
    const seen: any[] = [];
    const tts = new CloudTts({ key: () => undefined, fetchImpl: fakeFetch(seen) });
    const err = new Promise<Error>((r) => tts.on('error', (e) => r(e)));
    tts.speak(['Hi.'], voiceById('openai_marin'), 1);
    expect((await err).message).toMatch(/No OpenAI API key/);
    expect(seen).toHaveLength(0);
  });
  it('pcm16ToFloat keeps an odd byte for the next chunk', () => {
    const a = pcm16ToFloat(new Uint8Array([0, 0x40, 1]), null);
    expect(a.samples.length).toBe(1);
    expect(a.carry?.length).toBe(1);
    const b = pcm16ToFloat(new Uint8Array([0x40]), a.carry);
    expect(b.samples[0]).toBeCloseTo(0x4001 / 32768, 4);
  });
});

describe('streaming speech in the conversation', async () => {
  const { ConversationController } = await import('../src/main/conversation');
  function host(provider: any, log: string[]) {
    const settings = { provider: 'claude', voice: { speakReplies: 'voice', followUpSeconds: 0, wakeWord: 'cadabra', fastModelForVoice: true }, displayName: '' };
    return {
      settings: () => settings,
      now: () => Date.now(),
      provider: () => provider,
      model: (_id: string, o?: { voice?: boolean }) => (o?.voice ? 'fast' : 'smart'),
      gate: { beginRun() {} },
      buildTurn: () => ({ run: {}, request: {} }),
      setRun() {},
      afterRun() {},
      hasPendingConfirm: () => false,
      resolveConfirm() {},
      localLaunch: async () => null,
      localIntent: async () => null,
      voice: {
        stopSpeaking() {},
        armFollowUp() {},
        speak: async (t: string) => void log.push(`speak:${t}`),
        enabled: () => true,
        openStream: async () => ({ push: (xs: string[]) => void log.push(...xs.map((x) => `push:${x}`)), end: async () => void log.push('end') }),
      },
      ui: { busy() {}, event: (e: any) => e.type === 'text' && log.push(`ui:${e.delta}`), notice() {}, userEcho() {}, panelVisible: () => true },
    } as any;
  }
  it('the first sentence is spoken while the model is still writing; voice turns use the fast model', async () => {
    const log: string[] = [];
    let model = '';
    const provider = {
      send: (req: any) =>
        (async function* () {
          model = req.model;
          yield { type: 'text', delta: 'You have three new emails from Dana. ' };
          yield { type: 'text', delta: 'Anything else?' };
          yield { type: 'done' };
        })(),
    };
    const c = new ConversationController(host(provider, log));
    await c.onVoice('summarise my inbox', false);
    expect(model).toBe('fast');
    expect(log.indexOf('push:You have three new emails from Dana.')).toBeGreaterThan(-1);
    expect(log.indexOf('push:You have three new emails from Dana.')).toBeLessThan(log.indexOf('ui:Anything else?'));
    expect(log).not.toContain('push:Anything else?'); // round 10: generic closers aren't spoken
    expect(log.at(-1)).toBe('end');
    expect(log.some((l) => l.startsWith('speak:'))).toBe(false);
  });
  it('a slow backend gets one short "One moment." (sparingly)', async () => {
    vi.useFakeTimers();
    try {
      const log: string[] = [];
      const provider = {
        send: () =>
          (async function* () {
            await new Promise((r) => setTimeout(r, 4000));
            yield { type: 'text', delta: 'Done. The report is ready.' };
            yield { type: 'done' };
          })(),
      };
      const c = new ConversationController(host(provider, log));
      const p = c.onVoice('summarise the report', false);
      await vi.advanceTimersByTimeAsync(5000);
      await p;
      expect(log.filter((l) => l === 'push:One moment.').length).toBe(1);
      const p2 = c.onVoice('and the next one', true);
      await vi.advanceTimersByTimeAsync(5000);
      await p2;
      expect(log.filter((l) => l === 'push:One moment.').length).toBe(1); // not again within a minute
    } finally {
      vi.useRealTimers();
    }
  });
});
