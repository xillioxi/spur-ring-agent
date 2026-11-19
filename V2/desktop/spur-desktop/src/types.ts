export type AudioSource = 'ring' | 'microphone' | 'ring-recording';
export type ConnectionStatus = 'disconnected' | 'connecting' | 'authenticating' | 'connected' | 'syncing';
export interface RingDevice { id: string; name: string; rssi: number; compatible: boolean }
export interface Recording { id: string; name: string; path: string; size: number; timestamp: number; transcript?: string }
export interface Settings { hasApiKey: boolean; language: string; shortcut: string; insertAtCursor: boolean; source: AudioSource; credentialStore?: string }
export interface AppState {
  version: string;
  connection: ConnectionStatus;
  ringName: string;
  devices: RingDevice[];
  recordings: Recording[];
  transcript: { committed: string; partial: string };
  dictation: { status: 'idle' | 'armed' | 'starting' | 'listening' | 'stopping' | 'error'; source: AudioSource; insertAtCursor: boolean; targetLabel: string; error?: string; level: number };
  settings: Settings;
  service: { ready: boolean; error?: string };
  logs: { id: number; time: string; level: 'info' | 'error'; message: string }[];
  progress: number;
  busy: string | null;
  platform?: 'macos' | 'windows';
  permissions?: { accessibility: { required: boolean; granted: boolean; available?: boolean; message?: string }; microphone: string };
}
export interface SpurAPI {
  getState(): Promise<AppState>;
  onState(callback: (state: AppState) => void): () => void;
  scan(): Promise<void>;
  connect(id: string): Promise<void>;
  disconnect(): Promise<void>;
  sync(): Promise<void>;
  openRecording(id: string): Promise<void>;
  exportRecording(id: string): Promise<void>;
  openFolder(): Promise<void>;
  saveSettings(settings: { apiKey?: string; language: string; insertAtCursor: boolean; source: AudioSource }): Promise<void>;
  startDictation(): Promise<void>;
  stopDictation(): Promise<void>;
  copyTranscript(): Promise<void>;
  clearTranscript(): Promise<void>;
  transcribeRecording(id: string): Promise<void>;
  minimize(): Promise<void>;
  close(): Promise<void>;
  requestPermissions(): Promise<void>;
  sendMicrophoneChunk(pcm: Uint8Array): void;
  reportMicrophoneError(message: string): void;
}
declare global { interface Window { spur: SpurAPI } }
