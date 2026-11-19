import WebSocket from 'ws';
import { readFile, stat } from 'node:fs/promises';

export function realtimeURL(language: string): string {
  const url = new URL('wss://api.elevenlabs.io/v1/speech-to-text/realtime');
  url.searchParams.set('model_id', 'scribe_v2_realtime');
  url.searchParams.set('audio_format', 'pcm_16000');
  url.searchParams.set('commit_strategy', 'vad');
  url.searchParams.set('vad_silence_threshold_secs', '0.8');
  if (language !== 'auto') url.searchParams.set('language_code', language);
  return url.href;
}

export function serviceError(status: number): string {
  if (status === 401 || status === 403) return 'ElevenLabs rejected the API key. Check its speech-to-text permissions in Settings.';
  if (status === 402 || status === 429) return 'ElevenLabs quota or rate limit reached. Check your account and try again.';
  return `ElevenLabs request failed (HTTP ${status}). Your recording is still saved locally.`;
}

interface Callbacks { partial(text: string): void; committed(text: string): void; error(message: string): void }
type Factory = (url: string, apiKey: string) => WebSocket;

export class RealtimeTranscriber {
  private socket?: WebSocket;
  private ready = false;
  private stopping = false;
  private sentBytes = 0;
  private commitWaiter?: () => void;
  private failed = false;
  private startReject?: (error: Error) => void;
  private startTimer?: NodeJS.Timeout;
  private acceptingMessages = true;
  constructor(private key: string, private language: string, private callbacks: Callbacks,
    private factory: Factory = (url, key) => new WebSocket(url, { headers: { 'xi-api-key': key }, handshakeTimeout: 15000, maxPayload: 1024 * 1024 })) {}

  async start(): Promise<void> {
    if (this.socket) throw new Error('A transcription connection is already open.');
    await new Promise<void>((resolve, reject) => {
      this.startReject = reject;
      let connected = false;
      const timer = this.startTimer = setTimeout(() => { reject(new Error('ElevenLabs did not start the session in time.')); this.cancel(); }, 18000);
      const socket = this.socket = this.factory(realtimeURL(this.language), this.key);
      const failure = (message: string) => {
        clearTimeout(timer);
        if (this.failed || this.stopping) return;
        this.failed = true;
        this.acceptingMessages = false;
        if (!connected) reject(new Error(message)); else this.callbacks.error(message);
        this.ready = false;
        socket.terminate();
      };
      socket.on('unexpected-response', (_request, response) => failure(serviceError(response.statusCode || 500)));
      socket.on('error', () => failure('Could not connect to ElevenLabs. Check your internet connection and API key.'));
      socket.on('close', () => failure('The live transcription connection closed. Start a new session to continue.'));
      socket.on('message', data => {
        if (!this.acceptingMessages) return;
        try {
          const message = JSON.parse(data.toString());
          if (message.message_type === 'session_started') {
            connected = true; this.ready = true; this.startReject = undefined; clearTimeout(timer); resolve();
          } else if (message.message_type === 'partial_transcript' && typeof message.text === 'string') {
            this.callbacks.partial(message.text);
          } else if (message.message_type === 'committed_transcript' && typeof message.text === 'string') {
            if (message.text.trim()) this.callbacks.committed(message.text.trim());
            this.commitWaiter?.();
          } else if (message.message_type !== 'warning' &&
              (message.error || /error|quota|rate_limited|resource_exhausted|unaccepted_terms/.test(message.message_type || ''))) {
            const kind = String(message.message_type || 'error').replace(/_/g, ' ');
            failure(`ElevenLabs: ${kind}. Check your API key, available credits, and account access.`);
          }
        } catch { failure('ElevenLabs sent an invalid transcription response.'); }
      });
    });
  }

  send(pcm: Uint8Array): void {
    if (!this.ready || this.stopping || !this.socket) return;
    if (!pcm.byteLength || pcm.byteLength % 2 || pcm.byteLength > 64000) throw new Error('Expected a bounded 16-bit PCM audio chunk.');
    if (this.socket.bufferedAmount > 160000) {
      this.callbacks.error('The connection is too slow for live audio. Dictation was stopped.');
      this.cancel(); return;
    }
    this.sentBytes += pcm.byteLength;
    this.socket.send(JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: Buffer.from(pcm).toString('base64'), sample_rate: 16000, commit: false }));
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    const socket = this.socket;
    if (socket?.readyState === WebSocket.OPEN && this.ready && this.sentBytes) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, 3000);
        this.commitWaiter = () => { clearTimeout(timer); resolve(); };
        // The documented input_audio_chunk commit flag flushes the final phrase.
        socket.send(JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: Buffer.alloc(3200).toString('base64'), sample_rate: 16000, commit: true }));
      });
    }
    this.commitWaiter = undefined;
    this.ready = false;
    this.acceptingMessages = false;
    socket?.close();
    if (socket) setTimeout(() => { if (socket.readyState !== WebSocket.CLOSED) socket.terminate(); }, 1000).unref();
  }

  cancel(): void {
    this.stopping = true; this.ready = false;
    this.acceptingMessages = false;
    clearTimeout(this.startTimer);
    this.startReject?.(new Error('Live transcription was cancelled.'));
    this.startReject = undefined;
    this.socket?.terminate(); this.commitWaiter?.();
  }
}

export async function transcribeFile(file: string, key: string, language: string, signal?: AbortSignal): Promise<string> {
  const details = await stat(file);
  if (details.size > 64 * 1024 * 1024) throw new Error('This recording exceeds the 64 MB transcription limit.');
  const audio = await readFile(file);
  const body = new FormData();
  body.set('file', new Blob([audio], { type: 'audio/ogg' }), 'recording.ogg');
  body.set('model_id', 'scribe_v2');
  body.set('tag_audio_events', 'false');
  body.set('diarize', 'false');
  body.set('timestamps_granularity', 'none');
  if (language !== 'auto') body.set('language_code', language);
  const response = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
    method: 'POST', headers: { 'xi-api-key': key }, body,
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000),
  });
  if (!response.ok) throw new Error(serviceError(response.status));
  const result = await response.json() as { text?: unknown };
  if (typeof result.text !== 'string') throw new Error('ElevenLabs did not return a transcript.');
  return result.text.trim();
}
