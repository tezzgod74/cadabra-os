import { verifyWake } from './pipeline';
import { EventEmitter } from 'node:events';
import type { VoiceState } from '../../shared/types';

export interface VoiceUtterance {
  /** Full transcript including the wake word, e.g. "Cadabra, what's this error?" */
  text: string;
  /** Transcript after the wake word, e.g. "what's this error?" */
  request: string;
}

/**
 * Always-on voice pipeline. Everything up to (and including) wake-word
 * detection must run locally; audio never leaves the PC before the wake word.
 *
 * Events:
 *   'state'     (VoiceState)
 *   'level'     (number 0..1)      — mic level while listening (for the waveform)
 *   'partial'   (string)           — partial transcript while transcribing
 *   'utterance' (VoiceUtterance)   — wake word + request captured
 *   'error'     (Error)
 */
export interface VoiceEngine extends EventEmitter {
  readonly name: string;
  readonly state: VoiceState;
  /** Whether the engine's models/runtime are installed and usable. */
  available(): Promise<{ ok: boolean; detail: string }>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface Speaker {
  speak(text: string): Promise<void>;
  stop(): void;
}

/** Placeholder until the local engine is wired up; reports why voice is unavailable. */
export class UnavailableVoiceEngine extends EventEmitter implements VoiceEngine {
  readonly name = 'unavailable';
  state: VoiceState = 'off';
  constructor(private readonly reason: string) {
    super();
  }
  async available() {
    return { ok: false, detail: this.reason };
  }
  async start() {
    this.state = 'error';
    this.emit('state', this.state);
    this.emit('error', new Error(this.reason));
  }
  async stop() {
    this.state = 'off';
    this.emit('state', this.state);
  }
}

/** Strip a leading wake word ("Cadabra, ..." / "hey kadabra ...") from a transcript. */
export function splitWakeWord(transcript: string): VoiceUtterance | null {
  const t = transcript.trim();
  const v = verifyWake(t);
  return v ? { text: t, request: v.request } : null;
}
