import type { AppState, Recording } from '../src/types';
import { RealtimeTranscriber } from './transcription';

export function textGap(previous: string, next: string): string {
  return previous && /[\p{L}\p{N}.!?]$/u.test(previous) && /^[\p{L}\p{N}]/u.test(next) ? ' ' : '';
}
export function freshRingRecording(files: Recording[], baseline: Set<string>, start: number, end: number): Recording | undefined {
  const candidates = files.filter(file => !baseline.has(file.path) && Number.isFinite(file.timestamp) && file.timestamp >= start - 2 && file.timestamp <= end + 2);
  return candidates.length === 1 ? candidates[0] : undefined;
}
interface Ports {
  state: AppState;
  changed(): void;
  log(message: string, error?: boolean): void;
  request<T = any>(method: string, params?: Record<string, unknown>, timeout?: number): Promise<T>;
  key(): string;
  excludedPids(): number[];
  sync(): Promise<void>;
  transcribe(file: Recording, signal?: AbortSignal): Promise<string>;
  prepareSession?(): Promise<void>;
}

/** One explicit armed session; ring edges select segments, never manufacture audio. */
export class Dictation {
  private enabled = false;
  private generation = 0;
  private socket?: RealtimeTranscriber;
  private target?: Record<string, unknown>;
  private startPromise?: Promise<void>;
  private armPromise?: Promise<unknown>;
  private finishPromise?: Promise<void>;
  private stopPromise?: Promise<void>;
  private cancelCountdown?: () => void;
  private insertion = Promise.resolve();
  private queuedAudio: Uint8Array[] = [];
  private queuedBytes = 0;
  private socketReady = false;
  private lastInserted = '';
  private baseline = new Set<string>();
  private recordingStart?: number;
  private recordingFiles: Recording[] = [];
  private fileAbort?: AbortController;
  private cycleBusy = false;
  private suppressedUntil = 0;
  constructor(private ports: Ports) {}
  get active(): boolean { return this.enabled || Boolean(this.stopPromise); }
  private patch(values: Partial<AppState['dictation']>): void { Object.assign(this.ports.state.dictation, values); this.ports.changed(); }

  async start(delay = 3000): Promise<void> {
    if (this.stopPromise) await this.stopPromise;
    if (this.enabled) return;
    if (this.finishPromise) await this.finishPromise;
    if (this.startPromise) await this.startPromise.catch(() => {});
    if (this.enabled) return;
    const { state } = this.ports;
    if (!state.service.ready) throw new Error('The native ring service is not ready.');
    if (!this.ports.key()) throw new Error('Add your ElevenLabs API key in Settings first.');
    if (state.settings.source !== 'microphone' && state.connection !== 'connected') throw new Error('Connect your ring before arming ring dictation.');
    this.enabled = true; const generation = ++this.generation;
    this.suppressedUntil = 0;
    this.baseline = new Set(state.recordings.map(file => file.path));
    this.patch({ source: state.settings.source, insertAtCursor: state.settings.insertAtCursor, error: undefined, level: 0 });
    try {
      this.patch({ status: 'starting', targetLabel: 'Preparing dictation…' });
      if (this.ports.prepareSession) await this.ports.prepareSession();
      if (!this.enabled || generation !== this.generation) return;
      if (state.settings.source !== 'microphone') {
        this.patch({ status: 'starting', targetLabel: 'Enabling ring controls…' });
        this.armPromise = this.ports.request('armDictation');
        try { await this.armPromise; } finally { this.armPromise = undefined; }
        if (!this.enabled || generation !== this.generation) return;
        this.patch({ status: 'armed', targetLabel: state.settings.source === 'ring' ? 'Press your ring to dictate with the computer microphone' : 'Record on your ring, then release to transcribe' });
        this.ports.log(state.settings.source === 'ring' ? 'Ring controls armed. Live audio comes from the computer microphone, as in the reference Android app.' : 'Ring microphone armed. A completed new recording will be downloaded and sent to ElevenLabs.');
      } else await this.beginMicrophone(delay);
    } catch (error) { if (generation === this.generation) { await this.fail(error); throw error; } }
  }

  private async captureTarget(generation = this.generation): Promise<void> {
    this.target = undefined; this.lastInserted = '';
    if (this.ports.state.dictation.insertAtCursor) {
      const target = await this.ports.request('captureTarget', { excludedProcessIds: this.ports.excludedPids() });
      if (!this.enabled || generation !== this.generation) return;
      this.target = target;
      this.patch({ targetLabel: String(this.target?.label || 'Selected text field') });
    } else this.patch({ targetLabel: 'Transcript preview only' });
  }

  private async beginMicrophone(delay = 0): Promise<void> {
    if (!this.enabled || this.startPromise || this.socket) return;
    const generation = this.generation;
    this.startPromise = (async () => {
      this.patch({ status: 'starting', targetLabel: delay ? 'Click your destination text field within 3 seconds…' : 'Starting computer microphone…' });
      if (delay) await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, delay);
        this.cancelCountdown = () => { clearTimeout(timer); resolve(); };
      });
      this.cancelCountdown = undefined;
      if (!this.enabled || generation !== this.generation) return;
      await this.captureTarget();
      if (!this.enabled || generation !== this.generation) return;
      const socket = this.socket = new RealtimeTranscriber(this.ports.key(), this.ports.state.settings.language, {
        partial: text => { if (generation === this.generation) { this.ports.state.transcript.partial = text; this.ports.changed(); } },
        committed: text => { if (generation === this.generation) this.commit(text); },
        error: message => { if (generation === this.generation) void this.fail(new Error(message)); },
      });
      this.socketReady = false; this.queuedAudio = []; this.queuedBytes = 0;
      // Capture during the socket handshake, retaining a bounded pre-roll so first words are not lost.
      this.patch({ status: 'listening' });
      await socket.start();
      if (!this.enabled || generation !== this.generation) { socket.cancel(); return; }
      this.socketReady = true;
      for (const chunk of this.queuedAudio) socket.send(chunk);
      this.queuedAudio = []; this.queuedBytes = 0;
      this.ports.log('Live transcription connected to ElevenLabs.');
    })();
    try { await this.startPromise; } finally { this.startPromise = undefined; }
  }

  audio(pcm: Uint8Array): void {
    if (!this.enabled || this.ports.state.dictation.status !== 'listening' || !this.socket) return;
    try {
      if (this.socketReady) this.socket.send(pcm);
      else {
        if (this.queuedBytes + pcm.length > 160000) throw new Error('The live service took too long to connect. Audio capture was stopped.');
        this.queuedAudio.push(Uint8Array.from(pcm)); this.queuedBytes += pcm.length;
      }
      let energy = 0;
      const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
      for (let i = 0; i < pcm.byteLength; i += 2) energy += (view.getInt16(i, true) / 32768) ** 2;
      this.patch({ level: Math.min(1, Math.sqrt(energy / (pcm.length / 2)) * 5) });
    } catch (error) { void this.fail(error); }
  }

  private commit(text: string): void {
    const { transcript } = this.ports.state;
    transcript.committed += textGap(transcript.committed, text) + text;
    transcript.partial = ''; this.ports.changed();
    const generation = this.generation;
    this.insertion = this.insertion.then(async () => {
      if (!this.target || generation !== this.generation || !this.enabled) return;
      const value = textGap(this.lastInserted, text) + text;
      try {
        const result = await this.ports.request('insertText', { target: this.target, text: value });
        if (generation !== this.generation) return;
        if (!result.inserted) {
          this.target = undefined;
          this.ports.log('Text insertion paused because the destination changed. Your transcript is retained; copy it when ready.', true);
          this.patch({ targetLabel: 'Destination changed · transcript retained' });
        } else this.lastInserted += value;
      } catch (error) {
        if (generation !== this.generation) return;
        this.target = undefined;
        this.ports.log(`Text remains in the transcript: ${error instanceof Error ? error.message : 'The operating system could not insert it.'}`, true);
      }
    });
  }

  async trigger(action: 'start' | 'stop'): Promise<void> {
    if (!this.enabled || this.ports.state.dictation.source === 'microphone') return;
    if (action === 'start' && Date.now() < this.suppressedUntil) return;
    const generation = this.generation;
    try {
      if (this.ports.state.dictation.source === 'ring') {
        if (action === 'start' && !this.finishPromise) await this.beginMicrophone();
        else if (action === 'stop') await this.finishSegment();
      } else if (action === 'start' && !this.recordingStart && !this.cycleBusy) {
        const generation = this.generation;
        this.recordingStart = Date.now() / 1000;
        await this.captureTarget();
        if (!this.enabled || generation !== this.generation) return;
        this.patch({ status: 'listening', targetLabel: this.ports.state.dictation.targetLabel });
        this.ports.log('Recording on the ring microphone. Transcription starts after the recording ends.');
      } else if (action === 'stop' && this.recordingStart && !this.cycleBusy) {
        const start = this.recordingStart;
        this.recordingStart = undefined;
        await this.transcribeRingCycle(start, Date.now() / 1000);
      }
    } catch (error) { if (generation === this.generation) await this.fail(error); }
  }

  file(file: Recording): void { if (this.cycleBusy) this.recordingFiles.push(file); }
  ringTouch(action: string): void {
    if (!this.enabled || action !== 'double_click' || this.ports.state.dictation.source === 'microphone') return;
    this.suppressedUntil = Date.now() + 900;
    this.recordingStart = undefined;
    if (this.ports.state.dictation.source === 'ring') {
      // Android cancels a double-click segment instead of inserting accidental speech.
      this.generation++; this.socket?.cancel(); this.socket = undefined;
      this.socketReady = false; this.queuedAudio = []; this.queuedBytes = 0;
      this.target = undefined; this.ports.state.transcript.partial = '';
    }
    this.patch({ status: 'armed', level: 0 });
  }

  private async transcribeRingCycle(start: number, end: number): Promise<void> {
    this.cycleBusy = true; this.recordingFiles = [];
    const generation = this.generation;
    this.patch({ status: 'stopping', level: 0 });
    try {
      // Let AA11 settle to idle before requesting the saved file.
      await new Promise(resolve => setTimeout(resolve, 450));
      if (!this.enabled || generation !== this.generation) return;
      await this.ports.sync();
      if (!this.enabled || generation !== this.generation) return;
      const file = freshRingRecording(this.recordingFiles, this.baseline, start, end);
      for (const seen of this.recordingFiles) this.baseline.add(seen.path);
      if (!file) {
        this.ports.log('Could not identify exactly one fresh ring recording. Select the recording in the library to transcribe it manually.', true);
        return;
      }
      this.fileAbort = new AbortController();
      const text = await this.ports.transcribe(file, this.fileAbort.signal);
      if (this.enabled && generation === this.generation && text) { this.commit(text); await this.insertion; }
    } finally {
      this.fileAbort = undefined; this.cycleBusy = false;
      if (this.enabled && generation === this.generation) this.patch({ status: 'armed', level: 0 });
    }
  }

  private async finishSegment(): Promise<void> {
    if (this.finishPromise) return this.finishPromise;
    if (!this.socket && !this.startPromise) return;
    this.finishPromise = (async () => {
      this.patch({ status: 'stopping', level: 0 });
      try { await this.startPromise; } catch {}
      const socket = this.socket;
      if (socket) await socket.stop();
      await this.insertion;
      this.socket = undefined; this.socketReady = false; this.queuedAudio = []; this.queuedBytes = 0;
      if (this.enabled) this.patch({ status: this.ports.state.dictation.source === 'microphone' ? 'idle' : 'armed', level: 0 });
    })();
    try { await this.finishPromise; } finally { this.finishPromise = undefined; }
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.stopCurrent();
    try { await this.stopPromise; } finally { this.stopPromise = undefined; }
  }
  private async stopCurrent(): Promise<void> {
    if (!this.enabled) return;
    if (!this.socketReady && (this.startPromise || this.armPromise)) {
      // A cancelled countdown/arm must never acquire a target or open a microphone.
      this.enabled = false; this.generation++;
      this.cancelCountdown?.();
      this.socket?.cancel(); this.socket = undefined;
      this.queuedAudio = []; this.queuedBytes = 0;
      this.patch({ status: 'stopping', level: 0 });
      await Promise.allSettled([this.startPromise, this.armPromise].filter(Boolean));
      if (this.ports.state.dictation.source !== 'microphone') await this.ports.request('disarmDictation').catch(error => this.ports.log(String(error), true));
      this.patch({ status: 'idle', level: 0, targetLabel: '' });
      return;
    }
    this.fileAbort?.abort();
    await this.finishSegment();
    this.enabled = false; this.generation++;
    this.recordingStart = undefined; this.target = undefined;
    if (this.ports.state.dictation.source !== 'microphone') await this.ports.request('disarmDictation').catch(error => this.ports.log(String(error), true));
    this.patch({ status: 'idle', level: 0, targetLabel: '' });
  }
  async fail(error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : 'Dictation failed.';
    this.fileAbort?.abort(); this.socket?.cancel(); this.socket = undefined;
    this.enabled = false; this.generation++;
    this.queuedAudio = []; this.queuedBytes = 0;
    this.ports.state.transcript.partial = '';
    if (this.ports.state.dictation.source !== 'microphone') void this.ports.request('disarmDictation').catch(() => {});
    this.patch({ status: 'error', error: message, level: 0 });
    this.ports.log(message, true);
  }
}
