// Acceptance scenarios A & B end-to-end with a MOCKED backend:
// TTS-synthesized WAVs → real voice pipeline (wake, follow-up window without
// the wake word) → local fast paths / scripted fake model → tools (fake
// terminal) → spoken formatting. No real audio devices are used.
//   CADABRA_ASR_DIR=<parakeet> CADABRA_WAV_DIR=<wavs> npx vitest run test/scenarios.integration.test.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { VoicePipeline, type PipelineEvent } from '../src/main/voice/pipeline';
import { answerLocally } from '../src/shared/smalltalk';
import { parseLaunchIntent } from '../src/shared/apps';
import { toSpeech } from '../src/shared/speech';
import { ToolHost, type Effects } from '../src/main/tools';
import { SafetyGate } from '../src/main/safety-gate';
import { DEFAULT_SAFETY } from '../src/shared/safety';

const asrDir = process.env.CADABRA_ASR_DIR ?? '';
const wavDir = process.env.CADABRA_WAV_DIR ?? '';
const enabled = !!asrDir && fs.existsSync(asrDir) && !!wavDir && fs.existsSync(path.join(wavDir, 'scen-a1.wav'));

describe.skipIf(!enabled)('acceptance scenarios (voice + mocked backend)', () => {
  const sherpa = enabled ? createRequire(import.meta.url)('sherpa-onnx-node') : null;
  const mk = () => {
    const evs: PipelineEvent[] = [];
    const pipe = new VoicePipeline(
      sherpa,
      { modelsDir: path.resolve('resources/models'), asrDir, sensitivity: 0.5, workDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cv-')), refractoryMs: 0 },
      (e) => evs.push(e),
    );
    const say = (f: string) => {
      const before = evs.length;
      pipe.accept(sherpa.readWave(path.join(wavDir, f)).samples);
      pipe.accept(new Float32Array(16000));
      return evs.slice(before);
    };
    return { pipe, say, evs };
  };
  const utter = (evs: PipelineEvent[]) => evs.find((e) => e.type === 'utterance') as Extract<PipelineEvent, { type: 'utterance' }> | undefined;
  const now = new Date(2026, 9, 11, 10, 21);

  it('Scenario A: "Cadabra, are you there? What time is it." → local answer; "No. Thanks." (no wake word) → close', () => {
    const { pipe, say } = mk();
    const u1 = utter(say('scen-a1.wav'));
    expect(u1, 'wake + transcript').toBeTruthy();
    console.log('A1 heard:', u1?.text);
    const a1 = answerLocally(u1!.request, { now, name: 'Alex', firstTurn: true, voice: true });
    expect(a1).toEqual({ kind: 'answer', text: "Good morning, Alex. It's 10:21 AM. Anything I can help you with?" });
    // Cadabra speaks, then listens for a follow-up WITHOUT the wake word.
    pipe.armFollowUp(8000);
    const e2 = say('scen-a2.wav');
    const u2 = utter(e2);
    console.log('A2 heard:', u2?.text);
    expect(e2.some((e) => e.type === 'followup' && e.state === 'heard')).toBe(true);
    expect(u2?.followUp).toBe(true);
    expect(answerLocally(u2!.request, { now, firstTurn: false, voice: true })?.kind).toBe('close');
  });

  it('Scenario B: terminal + nslookup via the tool, spoken summary, follow-up question, close', async () => {
    const { pipe, say } = mk();
    const u1 = utter(say('scen-b1.wav'));
    expect(u1).toBeTruthy();
    console.log('B1 heard:', u1?.text);
    expect(answerLocally(u1!.request, { now, firstTurn: true, voice: true })).toBeNull(); // goes to the backend
    expect(parseLaunchIntent(u1!.request)).toBeNull(); // not a plain "open X"

    // Mocked backend: calls run_in_terminal with an allowlisted command (no confirmation needed).
    const ran: string[] = [];
    const fx: Effects = { ghostMoveTo: async () => {}, ghostClick: () => {}, ghostHide: () => {}, highlight: () => {}, clearPoint: async () => () => {}, status: () => {} };
    const gate = new SafetyGate(() => DEFAULT_SAFETY, { confirm: async () => false });
    const host = new ToolHost({} as any, gate, fx, undefined, undefined, {
      run: async (cmd) => {
        ran.push(cmd);
        return { output: 'Server:  one.one.one.one\nAddress:  1.1.1.1\n\nName:    dns.google\nAddress:  8.8.8.8', exitCode: '0', terminal: 'wt', timedOut: false };
      },
    });
    gate.beginRun();
    // The gate checks the host against what the user actually said (S6): pass the ASR text.
    host.run = { target: null, signal: new AbortController().signal, frame: null, nodes: new Map(), prompt: u1!.request };
    const tool = host.definitions().find((d) => d.name === 'run_in_terminal')!;
    const r: any = await tool.handler({ command: 'nslookup 8.8.8.8', description: 'Looking up 8.8.8.8' });
    expect(r.isError).toBeFalsy();
    expect(ran).toEqual(['nslookup 8.8.8.8']);
    expect(r.content[0].text).toContain('dns.google');
    // A non-allowlisted command gets the gate's own exact-command card; declined here.
    const bad: any = await tool.handler({ command: 'Remove-Item C:\\temp\\x' });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toMatch(/declined/);
    expect(ran).toHaveLength(1);

    expect(toSpeech('Here you go.')).toBe('Here you go.');
    pipe.armFollowUp(8000);
    const u2 = utter(say('scen-b2.wav'));
    console.log('B2 heard:', u2?.text);
    expect(u2?.followUp).toBe(true);
    expect(u2!.request.toLowerCase()).toMatch(/output/);
    expect(answerLocally(u2!.request, { now, firstTurn: false, voice: true })).toBeNull(); // backend answers from context
    const reply = '**8.8.8.8** resolves to `dns.google`. Anything else?\n\n```\nName: dns.google\n```';
    expect(toSpeech(reply)).toBe('8.8.8.8 resolves to dns.google. Anything else?');
    pipe.armFollowUp(8000);
    const u3 = utter(say('scen-b3.wav'));
    console.log('B3 heard:', u3?.text);
    expect(answerLocally(u3!.request, { now, firstTurn: false, voice: true })?.kind).toBe('close');
  });

  it('the follow-up window expires silently', () => {
    const { pipe, evs } = mk();
    pipe.armFollowUp(1000);
    pipe.accept(new Float32Array(16000 * 2));
    expect(evs.some((e) => e.type === 'followup' && e.state === 'expired')).toBe(true);
    expect(evs.some((e) => e.type === 'utterance')).toBe(false);
  });

  it('without the follow-up window, speech without the wake word is ignored', () => {
    const { say } = mk();
    expect(utter(say('scen-b2.wav'))).toBeUndefined();
  });
});
