// Natural voice (round 3): what the British voice actually says.
import { describe, expect, it } from 'vitest';
import { smallNumber, speechSentences, spokenClock, toSpokenText } from '../src/shared/spoken-text';
import { accentConfig, DEFAULT_SPEED, DEFAULT_VOICE, KOKORO_VOICES, voiceById } from '../src/shared/voices';
import { answerLocally } from '../src/shared/smalltalk';

describe('toSpokenText (British)', () => {
  it('reads times the British way', () => {
    expect(toSpokenText("It's 10:21 a.m.")).toBe("It's ten twenty-one a.m.");
    expect(toSpokenText('at 10:21 AM')).toBe('at ten twenty-one a.m.');
    expect(toSpokenText('at 3:05 p.m.')).toBe('at three oh five p.m.');
    expect(toSpokenText('by 12:00')).toBe('by twelve');
    expect(toSpokenText('at 22:05')).toBe('at twenty-two oh five');
    expect(spokenClock(9, 30)).toBe('nine thirty');
    expect(smallNumber(45)).toBe('forty-five');
  });
  it('reads IPs and host names', () => {
    expect(toSpokenText('8.8.8.8 resolves to dns.google.')).toBe('eight dot eight dot eight dot eight resolves to D N S dot google.');
    expect(toSpokenText('via 192.168.40.1')).toBe('via one nine two dot one six eight dot forty dot one');
    expect(toSpokenText('see example.co.uk')).toBe('see example dot co dot uk');
    expect(toSpokenText('e.g. this, and 50% off')).toBe('e.g. this, and 50 per cent off');
  });
  it('splits into sentences for streaming, keeping tiny fragments together', () => {
    expect(speechSentences("Good morning, Alex. It's ten twenty-one a.m. Anything I can do for you?")).toEqual([
      'Good morning, Alex.',
      "It's ten twenty-one a.m.",
      'Anything I can do for you?',
    ]);
    expect(speechSentences('Done. Ok. Next thing here.')).toEqual(['Done. Ok. Next thing here.']); // round 5: no tiny fragments
  });
  it('Scenario A line: the user’s own wording', () => {
    const a = answerLocally('Cadabra, are you there? What time is it.', { now: new Date(2026, 9, 11, 10, 21), name: 'Alex', firstTurn: true, voice: true });
    expect(a?.text).toBe("Good morning, Alex. It's 10:21 AM. Anything I can help you with?");
    expect(toSpokenText(a!.text)).toBe("Good morning, Alex. It's ten twenty-one a.m. Anything I can help you with?");
    expect(answerLocally('No. Thanks.', { now: new Date(), firstTurn: false, voice: true })?.text).toBe('Anytime.');
  });
});

describe('voices', () => {
  it('defaults to a refined British male at a natural pace (round 5: 1.05); ids match the model metadata', () => {
    expect(DEFAULT_VOICE).toBe('bm_george');
    expect(DEFAULT_SPEED).toBe(1.05);
    expect(voiceById('bm_george').sid).toBe(26);
    expect(voiceById('bf_emma').sid).toBe(21);
    expect(accentConfig(voiceById('bm_fable'))).toEqual({ lang: 'en-GB-x-rp', lexicon: 'lexicon-gb-en.txt' });
    expect(accentConfig(voiceById('af_heart')).lang).toBe('en-us');
    expect(KOKORO_VOICES.slice(0, 6).every((v) => v.accent === 'british')).toBe(true);
  });
});
