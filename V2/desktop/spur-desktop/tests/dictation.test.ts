import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AppState, AudioSource, Recording } from '../src/types';
import { Dictation, freshRingRecording, textGap } from '../electron/dictation';
import { RealtimeTranscriber } from '../electron/transcription';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const file = (path: string, timestamp: number): Recording => ({ id: path, name: path + '.ogg', path, size: 100, timestamp });

function harness(source: AudioSource = 'ring') {
  const state: AppState = {
    version: 'test', connection: 'connected', ringName: 'AIZO-RING', devices: [], recordings: [],
    transcript: { committed: '', partial: '' },
    dictation: { status: 'idle', source, insertAtCursor: true, targetLabel: '', level: 0 },
    settings: { hasApiKey: true, language: 'auto', shortcut: 'Ctrl+Shift+Space', insertAtCursor: true, source },
    service: { ready: true }, logs: [], progress: 0, busy: null,
  };
  const calls: { method: string; params?: Record<string, unknown> }[] = [];
  const target = { handle: 123, processId: 456, label: 'Test editor' };
  const ports: ConstructorParameters<typeof Dictation>[0] = {
    state, changed() {}, log() {}, key: () => 'test-key-never-sent', excludedPids: () => [1, 2],
    async request<T>(method: string, params?: Record<string, unknown>): Promise<T> {
      calls.push({ method, params });
      if (method === 'captureTarget') return target as T;
      if (method === 'insertText') return { inserted: true, count: String(params?.text).length } as T;
      return {} as T;
    },
    async sync() {}, async transcribe() { return 'Test transcript'; },
  };
  const dictation = new Dictation(ports);
  return { state, calls, ports, dictation, target };
}

test('textGap adds a boundary between English phrases without duplicating existing whitespace', () => {
  assert.equal(textGap('', 'hello'), '');
  assert.equal(textGap('Hello', 'world'), ' ');
  assert.equal(textGap('Hello.', 'Next'), ' ');
  assert.equal(textGap('Hello ', 'world'), '');
  assert.equal(textGap('Hello', ', world'), '');
});

test('fresh ring selection excludes baseline files, old timestamps and ambiguous new recordings', () => {
  const old = file('existing', 100);
  const fresh = file('new', 101);
  const baseline = new Set(['existing']);
  assert.equal(freshRingRecording([old, fresh, file('stale', 90)], baseline, 100, 102), fresh);
  assert.equal(freshRingRecording([old], baseline, 100, 102), undefined);
  assert.equal(freshRingRecording([fresh, file('also-new', 102)], baseline, 100, 102), undefined);
  assert.equal(freshRingRecording([file('invalid', Number.NaN)], baseline, 100, 102), undefined);
});

test('arming requires an API key and never starts capture until explicitly triggered', async () => {
  const h = harness();
  h.ports.key = () => '';
  await assert.rejects(h.dictation.start(), /API key/);
  assert.equal(h.dictation.active, false);
  assert.equal(h.calls.length, 0);
  h.ports.key = () => 'test';
  await h.dictation.start();
  await h.dictation.start();
  assert.equal(h.state.dictation.status, 'armed');
  assert.deepEqual(h.calls.map(call => call.method), ['armDictation']);
  await h.dictation.stop();
});

test('denied operating-system permission never arms the ring or starts the paid service', async t => {
  let starts = 0;
  t.mock.method(RealtimeTranscriber.prototype, 'start', async function () { starts++; });
  const h = harness();
  h.ports.prepareSession = async () => { throw new Error('Microphone permission denied'); };
  await assert.rejects(h.dictation.start(), /permission denied/);
  assert.equal(h.dictation.active, false);
  assert.equal(h.state.dictation.status, 'error');
  assert.equal(starts, 0);
  assert.equal(h.calls.filter(call => call.method === 'armDictation' || call.method === 'captureTarget').length, 0);
});

test('stopping while an OS permission prompt is pending prevents late capture', async t => {
  const permission = deferred<void>();
  let starts = 0;
  t.mock.method(RealtimeTranscriber.prototype, 'start', async function () { starts++; });
  const h = harness('microphone');
  h.ports.prepareSession = () => permission.promise;
  const starting = h.dictation.start(0);
  await h.dictation.stop();
  permission.resolve();
  await starting;
  assert.equal(starts, 0);
  assert.equal(h.dictation.active, false);
  assert.equal(h.state.dictation.status, 'idle');
  assert.equal(h.calls.length, 0);
});

test('duplicate ring start triggers open only one microphone transcription session', async t => {
  let starts = 0;
  t.mock.method(RealtimeTranscriber.prototype, 'start', async function () { starts++; });
  t.mock.method(RealtimeTranscriber.prototype, 'stop', async function () {});
  t.mock.method(RealtimeTranscriber.prototype, 'cancel', function () {});
  const h = harness();
  await h.dictation.start();
  await Promise.all([h.dictation.trigger('start'), h.dictation.trigger('start')]);
  assert.equal(starts, 1);
  assert.equal(h.calls.filter(call => call.method === 'captureTarget').length, 1);
  await Promise.all([h.dictation.trigger('stop'), h.dictation.trigger('stop')]);
  assert.equal(h.state.dictation.status, 'armed');
  await h.dictation.stop();
});

test('a ring double-click suppresses the following recording-state start edge', async t => {
  let starts = 0;
  t.mock.method(RealtimeTranscriber.prototype, 'start', async function () { starts++; });
  const h = harness();
  await h.dictation.start();
  h.dictation.ringTouch('double_click');
  await h.dictation.trigger('start');
  assert.equal(starts, 0);
  assert.equal(h.state.dictation.status, 'armed');
  await h.dictation.stop();
});

test('stop while arm request is pending cannot leave a late armed UI or session', async () => {
  const h = harness();
  const arm = deferred<Record<string, never>>();
  const request = h.ports.request;
  h.ports.request = async <T>(method: string, params?: Record<string, unknown>) => {
    if (method === 'armDictation') { h.calls.push({ method, params }); return await arm.promise as T; }
    return request<T>(method, params);
  };
  const starting = h.dictation.start();
  const stopping = h.dictation.stop();
  await tick();
  arm.resolve({});
  await Promise.all([starting, stopping]);
  assert.equal(h.dictation.active, false);
  assert.equal(h.state.dictation.status, 'idle');
  assert.equal(h.calls.filter(call => call.method === 'disarmDictation').length, 1);
});

test('stop during microphone countdown never captures a target or opens a paid session', async t => {
  let starts = 0;
  t.mock.method(RealtimeTranscriber.prototype, 'start', async function () { starts++; });
  t.mock.method(RealtimeTranscriber.prototype, 'stop', async function () {});
  t.mock.method(RealtimeTranscriber.prototype, 'cancel', function () {});
  const h = harness('microphone');
  const starting = h.dictation.start(20);
  const stopping = h.dictation.stop();
  await Promise.all([starting, stopping]);
  assert.equal(starts, 0);
  assert.equal(h.calls.filter(call => call.method === 'captureTarget').length, 0);
  assert.equal(h.dictation.active, false);
  assert.equal(h.state.dictation.status, 'idle');
});

test('a new start waits for pending stop cleanup before arming the next session', async () => {
  const h = harness();
  const firstArm = deferred<Record<string, never>>();
  let armCount = 0;
  const request = h.ports.request;
  h.ports.request = async <T>(method: string, params?: Record<string, unknown>) => {
    if (method === 'armDictation' && ++armCount === 1) {
      h.calls.push({ method, params });
      return await firstArm.promise as T;
    }
    return request<T>(method, params);
  };
  const firstStart = h.dictation.start();
  const stopping = h.dictation.stop();
  const nextStart = h.dictation.start();
  await tick();
  firstArm.resolve({});
  await Promise.all([firstStart, stopping, nextStart]);
  assert.equal(h.dictation.active, true);
  assert.equal(h.state.dictation.status, 'armed');
  assert.deepEqual(h.calls.map(call => call.method), ['armDictation', 'disarmDictation', 'armDictation']);
  await h.dictation.stop();
});

test('stop during ring-recording target capture ignores the late target and listening status', async () => {
  const h = harness('ring-recording');
  const capture = deferred<Record<string, unknown>>();
  const request = h.ports.request;
  h.ports.request = async <T>(method: string, params?: Record<string, unknown>) => {
    if (method === 'captureTarget') { h.calls.push({ method, params }); return await capture.promise as T; }
    return request<T>(method, params);
  };
  await h.dictation.start();
  const triggering = h.dictation.trigger('start');
  await tick();
  await h.dictation.stop();
  capture.resolve(h.target);
  await triggering;
  assert.equal(h.dictation.active, false);
  assert.equal(h.state.dictation.status, 'idle');
  assert.equal(h.state.dictation.targetLabel, '');
});

test('an aborted old file transcription cannot fail a newly armed session', async () => {
  const h = harness('ring-recording');
  const entered = deferred<void>();
  const transcription = deferred<string>();
  h.ports.sync = async () => { h.dictation.file(file('fresh-ring', Date.now() / 1000)); };
  h.ports.transcribe = async () => { entered.resolve(); return transcription.promise; };
  await h.dictation.start();
  await h.dictation.trigger('start');
  const oldCycle = h.dictation.trigger('stop');
  await entered.promise;
  await h.dictation.stop();
  await h.dictation.start();
  transcription.reject(new Error('The old request was aborted'));
  await oldCycle;
  assert.equal(h.dictation.active, true);
  assert.equal(h.state.dictation.status, 'armed');
  assert.equal(h.state.dictation.error, undefined);
  await h.dictation.stop();
});
