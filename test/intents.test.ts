import { describe, expect, it } from 'vitest';
import { normalizeUtterance, parseIntent, pickModelForTier } from '../src/shared/intents';
import { splitWakeWord } from '../src/main/voice/engine';

const claudeModels = [
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
  { id: 'claude-opus-5-5', label: 'Opus 5.5' },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5' },
  { id: 'claude-fable-5-1', label: 'Fable 5.1' },
];

describe('normalizeUtterance', () => {
  it('strips the wake word, punctuation and politeness', () => {
    expect(normalizeUtterance('Cadabra, switch to Copilot please!')).toBe('switch to copilot');
    expect(normalizeUtterance('Hey Cadabra... could you pause')).toBe('pause');
  });
});

describe('parseIntent', () => {
  it('switches providers', () => {
    expect(parseIntent('Cadabra, switch to Copilot')).toEqual({ kind: 'set-provider', provider: 'copilot' });
    expect(parseIntent('use claude')).toEqual({ kind: 'set-provider', provider: 'claude' });
    expect(parseIntent('switch over to OpenAI')).toEqual({ kind: 'set-provider', provider: 'codex' });
    expect(parseIntent('change to github copilot')).toEqual({ kind: 'set-provider', provider: 'copilot' });
    // Real Parakeet output for the TTS clip "Cadabra, switch to Copilot."
    expect(parseIntent('Cadabra switched to C pilot')).toEqual({ kind: 'set-provider', provider: 'copilot' });
    expect(parseIntent('switch to co-pilot')).toEqual({ kind: 'set-provider', provider: 'copilot' });
  });
  it('picks model tiers', () => {
    expect(parseIntent('use the faster model')).toEqual({ kind: 'model-tier', tier: 'fast' });
    expect(parseIntent('switch to the smartest model')).toEqual({ kind: 'model-tier', tier: 'smart' });
  });
  it('picks a named model', () => {
    expect(parseIntent('use opus', { models: claudeModels })).toEqual({ kind: 'set-model', model: 'claude-opus-5-5', label: 'Opus 5.5' });
    expect(parseIntent('switch to haiku', { models: claudeModels })).toEqual({ kind: 'set-model', model: 'claude-haiku-5-5', label: 'Haiku 5.5' });
  });
  it('voice and spoken replies', () => {
    expect(parseIntent('turn off voice')).toEqual({ kind: 'voice', enabled: false });
    expect(parseIntent('Cadabra, stop listening')).toEqual({ kind: 'voice', enabled: false });
    expect(parseIntent('turn the voice on')).toEqual({ kind: 'voice', enabled: true });
    expect(parseIntent('read your answers aloud')).toEqual({ kind: 'speak-replies', enabled: true });
    expect(parseIntent('stop talking')).toEqual({ kind: 'speak-replies', enabled: false });
  });
  it('pause, resume, new chat', () => {
    expect(parseIntent('pause')).toEqual({ kind: 'pause' });
    expect(parseIntent('Cadabra, take a break')).toEqual({ kind: 'pause' });
    expect(parseIntent('resume')).toEqual({ kind: 'resume' });
    expect(parseIntent('start over')).toEqual({ kind: 'new-chat' });
    expect(parseIntent('Cadabra, change my shortcut')).toEqual({ kind: 'shortcut' });
    expect(parseIntent('change the hotkey')).toEqual({ kind: 'shortcut' });
    expect(parseIntent('rebind the summon shortcut')).toEqual({ kind: 'shortcut' });
  });
  it('does NOT hijack real requests', () => {
    expect(parseIntent('use the faster model to summarize this page and then email it to Dana')).toBeNull();
    expect(parseIntent('what does this error mean?')).toBeNull();
    expect(parseIntent('use the search box to find invoices')).toBeNull();
    expect(parseIntent('pause the video')).toBeNull();
    expect(parseIntent('click send')).toBeNull();
  });
});

describe('pickModelForTier', () => {
  it('ranks by model family', () => {
    expect(pickModelForTier(claudeModels, 'fast')?.id).toBe('claude-haiku-5-5');
    expect(pickModelForTier(claudeModels, 'smart')?.id).toBe('claude-fable-5-1');
    expect(pickModelForTier([{ id: 'gpt-6-luna', label: 'GPT-6 Luna' }, { id: 'gpt-6-astra', label: 'Astra' }], 'fast')?.id).toBe('gpt-6-luna');
    expect(pickModelForTier([{ id: 'x', label: 'Mystery' }], 'fast')).toBeUndefined();
  });
});

describe('splitWakeWord', () => {
  it('extracts the request after the wake word', () => {
    expect(splitWakeWord("Cadabra, what's this error?")).toEqual({ text: "Cadabra, what's this error?", request: "what's this error?" });
    expect(splitWakeWord('hey kadabra open spotify')?.request).toBe('open spotify');
    expect(splitWakeWord('ka dabra pause')?.request).toBe('pause');
  });
  it('rejects transcripts that do not start with the wake word', () => {
    expect(splitWakeWord('so I said cadabra to him')).toBeNull();
    expect(splitWakeWord('candelabra on the table')).toBeNull();
  });
});

describe('A1: name intents', () => {
  it('"call me X" / "my name is X" set the name; look-alikes don\'t', () => {
    expect(parseIntent('Cadabra, call me Alex')).toEqual({ kind: 'name', name: 'alex' });
    expect(parseIntent('my name is Mary Jane')).toEqual({ kind: 'name', name: 'mary jane' });
    expect(parseIntent("don't use my name")).toEqual({ kind: 'name', name: '' });
    expect(parseIntent('call me back later')).toBeNull();
    expect(parseIntent('call mom')).toBeNull();
  });
  it('gemini is a backend word', () => {
    expect(parseIntent('switch to gemini')).toEqual({ kind: 'set-provider', provider: 'gemini' });
  });
});
