import type { AppState } from './types';

/** Capture is armed only by the main process after an explicit start action. */
export function installMicrophoneCapture(): () => void {
  let active = false;
  let generation = 0;
  let stream: MediaStream | undefined;
  let context: AudioContext | undefined;
  let node: AudioWorkletNode | undefined;
  let receivedUpdate = false;
  const stop = () => {
    generation++;
    stream?.getTracks().forEach(track => track.stop());
    node?.disconnect();
    void context?.close();
    stream = undefined; context = undefined; node = undefined;
  };
  const update = async (state: AppState) => {
    const shouldCapture = state.dictation.source !== 'ring-recording' && state.dictation.status === 'listening';
    if (shouldCapture === active) return;
    active = shouldCapture;
    if (!active) { stop(); return; }
    const current = ++generation;
    try {
      const media = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      if (current !== generation) { media.getTracks().forEach(track => track.stop()); return; }
      stream = media;
      context = new AudioContext({ sampleRate: 16000 });
      await context.audioWorklet.addModule(new URL('pcm-worklet.js', document.baseURI).href);
      if (current !== generation || !context) return;
      node = new AudioWorkletNode(context, 'spur-pcm', { processorOptions: { inputRate: context.sampleRate } });
      node.port.onmessage = event => {
        if (current === generation && active && event.data instanceof ArrayBuffer) window.spur.sendMicrophoneChunk(new Uint8Array(event.data));
      };
      context.createMediaStreamSource(media).connect(node);
      // The worklet emits silence to its output; connecting keeps capture running without monitoring.
      node.connect(context.destination);
      await context.resume();
    } catch (error) {
      if (current === generation) {
        active = false; stop();
        window.spur.reportMicrophoneError(error instanceof Error ? error.message : 'Microphone capture failed.');
      }
    }
  };
  const unsubscribe = window.spur.onState(state => { receivedUpdate = true; void update(state); });
  void window.spur.getState().then(state => { if (!receivedUpdate) void update(state); }).catch(() => {});
  return () => { unsubscribe(); active = false; stop(); };
}
