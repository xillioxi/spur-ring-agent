import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import type WebSocket from 'ws';
import { realtimeURL, RealtimeTranscriber, serviceError } from '../electron/transcription';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

/** No socket is opened: these events represent the ws library's public surface. */
class FakeWebSocket extends EventEmitter {
  readyState = 0;
  bufferedAmount = 0;
  sent: Record<string, unknown>[] = [];
  terminated = false;
  closed = false;
  onSend?: (message: Record<string, unknown>) => void;

  open(): void { this.readyState = 1; this.emit('open'); }
  message(message: Record<string, unknown>): void {
    this.emit('message', Buffer.from(JSON.stringify(message)));
  }
  send(raw: string): void {
    const message = JSON.parse(raw) as Record<string, unknown>;
    this.sent.push(message);
    this.onSend?.(message);
  }
  close(): void {
    this.closed = true; this.readyState = 3; this.emit('close');
  }
  terminate(): void {
    this.terminated = true; this.readyState = 3; this.emit('close');
  }
}

function harness(language = 'auto') {
  const socket = new FakeWebSocket();
  const partial: string[] = [], committed: string[] = [], errors: string[] = [];
  const requests: { url: string; key: string }[] = [];
  const transcriber = new RealtimeTranscriber('fake-key-no-network', language, {
    partial: text => partial.push(text),
    committed: text => committed.push(text),
    error: message => errors.push(message),
  }, (url, key) => {
    requests.push({ url, key });
    return socket as unknown as WebSocket;
  });
  async function ready() {
    const starting = transcriber.start();
    socket.open();
    socket.message({ message_type: 'session_started' });
    await starting;
  }
  return { socket, transcriber, partial, committed, errors, requests, ready };
}

test('realtime URL configures Scribe, PCM16k, VAD and optional language without credentials', () => {
  const automatic = new URL(realtimeURL('auto'));
  assert.equal(automatic.origin, 'wss://api.elevenlabs.io');
  assert.equal(automatic.pathname, '/v1/speech-to-text/realtime');
  assert.equal(automatic.searchParams.get('model_id'), 'scribe_v2_realtime');
  assert.equal(automatic.searchParams.get('audio_format'), 'pcm_16000');
  assert.equal(automatic.searchParams.get('commit_strategy'), 'vad');
  assert.equal(automatic.searchParams.get('vad_silence_threshold_secs'), '0.8');
  assert.equal(automatic.searchParams.has('language_code'), false);
  assert.equal(new URL(realtimeURL('zh')).searchParams.get('language_code'), 'zh');
  assert.equal([...automatic.searchParams.keys()].some(key => /key|token|auth/i.test(key)), false);
});

test('opening WebSocket does not start capture until session_started arrives', async t => {
  const h = harness('en');
  t.after(() => h.transcriber.cancel());
  let started = false;
  const starting = h.transcriber.start().then(() => { started = true; });
  h.socket.open();
  h.transcriber.send(new Uint8Array([0, 0]));
  await tick();
  assert.equal(started, false);
  assert.deepEqual(h.socket.sent, []);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].key, 'fake-key-no-network');
  assert.equal(h.requests[0].url.includes(h.requests[0].key), false);
  h.socket.message({ message_type: 'session_started' });
  await starting;
  assert.equal(started, true);
  await assert.rejects(h.transcriber.start(), /already open/);
});

test('PCM serialization respects a typed-array slice and carries its exact base64 length', async t => {
  const h = harness();
  t.after(() => h.transcriber.cancel());
  await h.ready();
  const backing = new Uint8Array([255, 255, 0, 128, 255, 127, 1, 0, 255, 255]);
  const pcm = backing.subarray(2, 8);
  h.transcriber.send(pcm);
  assert.equal(h.socket.sent.length, 1);
  const chunk = h.socket.sent[0];
  assert.deepEqual(Object.keys(chunk).sort(), ['audio_base_64', 'commit', 'message_type', 'sample_rate']);
  assert.equal(chunk.message_type, 'input_audio_chunk');
  assert.equal(chunk.sample_rate, 16000);
  assert.equal(chunk.commit, false);
  assert.equal((chunk.audio_base_64 as string).length, 4 * Math.ceil(pcm.byteLength / 3));
  assert.deepEqual(Buffer.from(chunk.audio_base_64 as string, 'base64'), Buffer.from([0, 128, 255, 127, 1, 0]));
});

test('empty, odd-length and oversized PCM are rejected before sending', async t => {
  const h = harness();
  t.after(() => h.transcriber.cancel());
  await h.ready();
  for (const size of [0, 1, 3, 64002]) {
    assert.throws(() => h.transcriber.send(new Uint8Array(size)), /bounded 16-bit PCM/);
  }
  assert.equal(h.socket.sent.length, 0);
  h.transcriber.send(new Uint8Array(64000));
  assert.equal(Buffer.from(h.socket.sent[0].audio_base_64 as string, 'base64').length, 64000);
});

test('only committed_transcript contributes finalized text; edited and timestamp messages do not duplicate it', async t => {
  const h = harness();
  t.after(() => h.transcriber.cancel());
  await h.ready();
  h.socket.message({ message_type: 'partial_transcript', text: 'hel' });
  h.socket.message({ message_type: 'committed_transcript', text: '  Hello world.  ' });
  h.socket.message({ message_type: 'committed_transcript_with_timestamps', text: 'Hello world.', words: [] });
  h.socket.message({ message_type: 'edited_transcript', text: 'Hello, world!' });
  h.socket.message({ message_type: 'committed_transcript', text: '  ' });
  h.socket.message({ message_type: 'committed_transcript', text: 42 });
  h.socket.message({ message_type: 'warning', message: 'informational' });
  assert.deepEqual(h.partial, ['hel']);
  assert.deepEqual(h.committed, ['Hello world.']);
  assert.deepEqual(h.errors, []);
});

for (const [status, category] of [
  [401, /API key.*permissions/], [403, /API key.*permissions/],
  [402, /quota or rate limit/], [429, /quota or rate limit/],
  [503, /HTTP 503.*saved locally/],
] as const) {
  test(`HTTP ${status} handshake rejection returns a useful status category without exposing the key`, async t => {
    const h = harness();
    t.after(() => h.transcriber.cancel());
    const starting = h.transcriber.start();
    const rejection = assert.rejects(starting, error => {
      assert.equal((error as Error).message, serviceError(status));
      assert.match((error as Error).message, category);
      assert.equal((error as Error).message.includes('fake-key-no-network'), false);
      return true;
    });
    h.socket.emit('unexpected-response', {}, { statusCode: status });
    await rejection;
    assert.equal(h.socket.terminated, true);
    assert.deepEqual(h.errors, [], 'A failed handshake must reject start instead of reporting a second running-session error');
  });
}

test('service auth errors after readiness stop sending and report exactly once', async t => {
  const h = harness();
  t.after(() => h.transcriber.cancel());
  await h.ready();
  h.socket.message({ message_type: 'auth_error', error: 'provider detail must not expose credentials' });
  h.socket.emit('close');
  h.transcriber.send(new Uint8Array([0, 0]));
  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0], /auth error/);
  assert.equal(h.socket.terminated, true);
  assert.equal(h.socket.sent.length, 0);
});

test('stop commits outstanding audio, accepts the flushed final phrase, then closes', async t => {
  const h = harness();
  t.after(() => h.transcriber.cancel());
  await h.ready();
  h.transcriber.send(new Uint8Array([0, 0, 1, 0]));
  let finalBeforeClose = false;
  h.socket.onSend = message => {
    if (message.commit === true) queueMicrotask(() => {
      finalBeforeClose = !h.socket.closed;
      h.socket.message({ message_type: 'committed_transcript', text: ' Last phrase. ' });
    });
  };
  await h.transcriber.stop();
  assert.equal(finalBeforeClose, true);
  assert.deepEqual(h.committed, ['Last phrase.']);
  assert.equal(h.socket.sent.length, 2);
  assert.equal(h.socket.sent[1].commit, true);
  assert.equal(h.socket.sent[1].message_type, 'input_audio_chunk');
  assert.equal(h.socket.sent[1].sample_rate, 16000);
  assert.equal(Buffer.from(h.socket.sent[1].audio_base_64 as string, 'base64').length, 3200);
  assert.equal(h.socket.closed, true);
  assert.deepEqual(h.errors, []);
  h.socket.message({ message_type: 'partial_transcript', text: 'late partial after stop' });
  h.socket.message({ message_type: 'committed_transcript', text: 'late final after stop' });
  assert.deepEqual(h.partial, []);
  assert.deepEqual(h.committed, ['Last phrase.']);
  h.transcriber.send(new Uint8Array([0, 0]));
  assert.equal(h.socket.sent.length, 2);
});

test('stop without audio closes without committing an empty phrase', async t => {
  const h = harness();
  t.after(() => h.transcriber.cancel());
  await h.ready();
  await h.transcriber.stop();
  assert.equal(h.socket.closed, true);
  assert.deepEqual(h.socket.sent, []);
});

test('cancel during handshake promptly rejects start and ignores all late session messages', { timeout: 1000 }, async () => {
  const h = harness();
  const starting = h.transcriber.start();
  const rejection = assert.rejects(starting, /cancelled/);
  h.transcriber.cancel();
  await rejection;
  assert.equal(h.socket.terminated, true);
  h.socket.message({ message_type: 'session_started' });
  h.socket.message({ message_type: 'partial_transcript', text: 'stale partial' });
  h.socket.message({ message_type: 'committed_transcript', text: 'stale insertion' });
  h.transcriber.send(new Uint8Array([0, 0]));
  assert.deepEqual(h.partial, []);
  assert.deepEqual(h.committed, []);
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.socket.sent, []);
});
