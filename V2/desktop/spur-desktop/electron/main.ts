import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, net, protocol, safeStorage, session, shell, systemPreferences } from 'electron';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AppState, Recording, Settings } from '../src/types';
import { RingService } from './bridge';
import { Dictation } from './dictation';
import { transcribeFile } from './transcription';
import { desktopEnvironment } from './platform';

protocol.registerSchemesAsPrivileged([{ scheme: 'spur', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
const selfTest = process.argv.includes('--self-test');
const root = app.getAppPath();
const environment = desktopEnvironment(process.platform, app.getPath('home'), app.getPath('appData'), process.env.LOCALAPPDATA);
const dataRoot = environment.dataRoot;
const settingsFile = path.join(dataRoot, 'desktop-ui.json');
const keyFile = path.join(dataRoot, 'elevenlabs-key.bin');
let window: BrowserWindow | undefined;
let quitting = false;
let diagnosticExitCode: number | undefined;
let logSequence = 0;
let apiKey = '';
let dictation: Dictation;
const settings: Settings = { hasApiKey: false, language: 'auto', shortcut: environment.shortcut, insertAtCursor: true, source: 'ring', credentialStore: environment.credentialStore };
const state: AppState = {
  version: app.getVersion(), connection: 'disconnected', ringName: 'Your Spur Ring', devices: [], recordings: [],
  transcript: { committed: '', partial: '' },
  dictation: { status: 'idle', source: 'ring', insertAtCursor: true, targetLabel: '', level: 0 },
  settings, service: { ready: false }, logs: [], progress: 0, busy: null, platform: environment.mac ? 'macos' : 'windows',
};
const changed = () => { if (window && !window.isDestroyed()) window.webContents.send('spur:state', state); };
function log(message: string, error = false): void {
  state.logs = [...state.logs.slice(-149), { id: ++logSequence, time: new Date().toISOString(), level: error ? 'error' : 'info', message }];
  changed();
}
function atomicJSON(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.tmp';
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, file);
}
function loadSettings(): void {
  if (existsSync(settingsFile)) {
    try {
      const value = JSON.parse(readFileSync(settingsFile, 'utf8'));
      if (['ring', 'microphone', 'ring-recording'].includes(value.source)) settings.source = value.source;
      if (typeof value.insertAtCursor === 'boolean') settings.insertAtCursor = value.insertAtCursor;
      if (typeof value.language === 'string' && /^(auto|[a-z]{2,3})$/.test(value.language)) settings.language = value.language;
    } catch { log('Could not read saved preferences. Default preferences are in use.', true); }
  }
  if (process.env.ELEVENLABS_API_KEY) apiKey = process.env.ELEVENLABS_API_KEY;
  else if (existsSync(keyFile)) {
    try { apiKey = safeStorage.decryptString(readFileSync(keyFile)); }
    catch { log('Your saved ElevenLabs key could not be unlocked. Enter it again in Settings.', true); }
  }
  settings.hasApiKey = Boolean(apiKey);
  Object.assign(state.dictation, { source: settings.source, insertAtCursor: settings.insertAtCursor });
}
const service = new RingService(event => {
  if (event.type === 'status') {
    state.connection = event.status;
    if (event.status === 'disconnected' && dictation?.active) void dictation.fail(new Error('The ring disconnected. Dictation stopped; your transcript is retained.'));
    if (event.message) log(event.message);
  } else if (event.type === 'log') log(event.message);
  else if (event.type === 'error') log(event.message, true);
  else if (event.type === 'progress') state.progress = event.progress;
  else if (event.type === 'dictation-trigger') void dictation?.trigger(event.action);
  else if (event.type === 'ring-touch') dictation?.ringTouch(event.action);
  else if (event.type === 'recording') {
    const file = toRecording(event.file);
    if (file) { dictation?.file(file); void refreshLibrary().catch(error => log(String(error), true)); }
  }
  changed();
}, message => {
  state.service = { ready: false, error: message }; state.connection = 'disconnected';
  if (!quitting) { log(message, true); if (dictation?.active) void dictation.fail(new Error(message)); }
});
function toRecording(raw: any): Recording | undefined {
  if (!raw || typeof raw.path !== 'string' || typeof raw.name !== 'string') return;
  const absolute = path.resolve(raw.path);
  const relative = path.relative(path.join(dataRoot, 'recordings'), absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative) || !absolute.endsWith('.ogg')) return;
  const id = createHash('sha256').update(absolute.toLowerCase()).digest('hex').slice(0, 24);
  let transcript: string | undefined;
  try { const saved = JSON.parse(readFileSync(absolute + '.transcript.json', 'utf8')); if (typeof saved.text === 'string') transcript = saved.text; } catch {}
  return { id, name: raw.name, path: absolute, size: Number(raw.size), timestamp: Number(raw.timestamp), transcript };
}
async function refreshLibrary(): Promise<void> {
  const recordings = await service.request<any[]>('listRecordings');
  state.recordings = recordings.map(toRecording).filter((file): file is Recording => Boolean(file));
  changed();
}
async function sync(): Promise<void> {
  if (state.busy) throw new Error(`Wait until ${state.busy} finishes.`);
  state.busy = 'syncing recordings'; changed();
  try { await service.request('sync', {}, 240000); await refreshLibrary(); }
  finally { state.busy = null; changed(); }
}
async function transcribe(file: Recording, signal?: AbortSignal): Promise<string> {
  if (!apiKey) throw new Error('Add your ElevenLabs API key in Settings first.');
  log(`Transcribing ${file.name} with ElevenLabs…`);
  const text = await transcribeFile(file.path, apiKey, settings.language, signal);
  atomicJSON(file.path + '.transcript.json', { schema: 1, text, service: 'ElevenLabs', model: 'scribe_v2', createdAt: new Date().toISOString() });
  await refreshLibrary();
  log(text ? 'Transcript saved alongside the original recording.' : 'No speech was recognized. The original recording is retained.');
  return text;
}
function selectedFile(id: unknown): Recording {
  const file = state.recordings.find(recording => recording.id === id);
  if (!file || !existsSync(file.path)) throw new Error('This recording is no longer available. Refresh the library.');
  return file;
}
async function saveSettings(value: unknown): Promise<void> {
  if (dictation.active) throw new Error('Stop or disarm dictation before changing its settings.');
  if (!value || typeof value !== 'object') throw new Error('Invalid settings.');
  const next = value as Record<string, unknown>;
  if (!['ring', 'microphone', 'ring-recording'].includes(String(next.source)) || typeof next.insertAtCursor !== 'boolean' || typeof next.language !== 'string' || !/^(auto|[a-z]{2,3})$/.test(next.language)) throw new Error('Choose a valid audio source and language.');
  if (next.apiKey !== undefined) {
    if (typeof next.apiKey !== 'string' || !next.apiKey.trim() || next.apiKey.length > 1024 || /[\r\n]/.test(next.apiKey)) throw new Error('Enter a valid ElevenLabs API key.');
    if (!safeStorage.isEncryptionAvailable()) throw new Error(`${environment.credentialStore} credential encryption is unavailable. Your API key was not saved.`);
    const encrypted = safeStorage.encryptString(next.apiKey.trim());
    mkdirSync(dataRoot, { recursive: true });
    writeFileSync(keyFile + '.tmp', encrypted, { mode: 0o600 }); renameSync(keyFile + '.tmp', keyFile);
    apiKey = next.apiKey.trim();
  }
  Object.assign(settings, { source: next.source, language: next.language, insertAtCursor: next.insertAtCursor, hasApiKey: Boolean(apiKey) });
  atomicJSON(settingsFile, { schema: 1, source: settings.source, language: settings.language, insertAtCursor: settings.insertAtCursor });
  Object.assign(state.dictation, { source: settings.source, insertAtCursor: settings.insertAtCursor, error: undefined, status: 'idle' });
  log(`Preferences saved. API credentials stay in the desktop process and are protected by ${environment.credentialStore}.`);
}
async function refreshPermissions(promptAccessibility = false): Promise<void> {
  if (!environment.mac) return;
  const permissions = await service.request<{ accessibility: { required: boolean; granted: boolean; available?: boolean; message?: string } }>(promptAccessibility ? 'requestInputPermissions' : 'getInputPermissions');
  state.permissions = { accessibility: permissions.accessibility, microphone: systemPreferences.getMediaAccessStatus('microphone') };
  changed();
}
async function prepareSession(): Promise<void> {
  if (!environment.mac) return;
  if (settings.source !== 'ring-recording' && systemPreferences.getMediaAccessStatus('microphone') !== 'granted') {
    const granted = await systemPreferences.askForMediaAccess('microphone');
    if (!granted) throw new Error('Allow Spur Desktop in System Settings → Privacy & Security → Microphone, then restart the app.');
  }
  await refreshPermissions(settings.insertAtCursor);
  if (settings.insertAtCursor && !state.permissions?.accessibility.granted) throw new Error('Allow Spur Desktop and its ring helper, if listed, in System Settings → Privacy & Security → Accessibility, then start dictation again.');
}
async function command(method: unknown, argument?: unknown): Promise<unknown> {
  switch (method) {
    case 'getState': return state;
    case 'scan': {
      if (state.busy || dictation.active) throw new Error('Finish the current operation before scanning.');
      state.busy = 'scanning'; changed();
      try { state.devices = await service.request('scan'); } finally { state.busy = null; changed(); }
      return;
    }
    case 'connect': {
      if (state.busy || dictation.active) throw new Error('Finish the current operation first.');
      const device = state.devices.find(device => device.id === argument);
      if (!device) throw new Error('Scan and select your ring first.');
      state.busy = 'connecting'; changed();
      try { await service.request('connect', { address: device.id }, 95000); state.ringName = device.name; }
      finally { state.busy = null; changed(); }
      return;
    }
    case 'disconnect': await dictation.stop(); await service.request('disconnect'); return;
    case 'sync': if (dictation.active) throw new Error('Disarm dictation before a manual sync.'); return sync();
    case 'openRecording': { const error = await shell.openPath(selectedFile(argument).path); if (error) throw new Error(error); return; }
    case 'exportRecording': {
      const file = selectedFile(argument);
      const result = await dialog.showSaveDialog(window!, { defaultPath: file.name, filters: [{ name: 'Ogg Opus recording', extensions: ['ogg'] }] });
      if (!result.canceled && result.filePath) await copyFile(file.path, result.filePath);
      return;
    }
    case 'openFolder': { const error = await shell.openPath(path.join(dataRoot, 'recordings')); if (error) throw new Error(error); return; }
    case 'saveSettings': return saveSettings(argument);
    case 'startDictation': return dictation.start();
    case 'stopDictation': return dictation.stop();
    case 'copyTranscript': clipboard.writeText(state.transcript.committed); return;
    case 'clearTranscript': if (dictation.active) throw new Error('Stop or disarm dictation before clearing the transcript.'); state.transcript = { committed: '', partial: '' }; changed(); return;
    case 'transcribeRecording': {
      if (state.busy || dictation.active) throw new Error('Finish the current operation before transcribing a recording.');
      const file = selectedFile(argument); state.busy = 'transcribing'; changed();
      try { const text = await transcribe(file); state.transcript = { committed: text, partial: '' }; changed(); }
      finally { state.busy = null; changed(); }
      return;
    }
    case 'minimize': window?.minimize(); return;
    case 'close': window?.close(); return;
    case 'requestPermissions': {
      if (dictation.active) throw new Error('Stop or disarm dictation before changing permissions.');
      if (environment.mac) {
        if (settings.source !== 'ring-recording' && systemPreferences.getMediaAccessStatus('microphone') === 'not-determined') await systemPreferences.askForMediaAccess('microphone');
        await refreshPermissions(true);
        if (!state.permissions?.accessibility.granted) log('Enable Accessibility for Spur Desktop and its helper, if listed, in System Settings → Privacy & Security.');
      }
      return;
    }
    default: throw new Error('Unknown desktop action.');
  }
}

async function createWindow(): Promise<void> {
  const dist = path.join(root, 'dist');
  protocol.handle('spur', request => {
    const url = new URL(request.url);
    if (url.hostname !== 'app') return new Response('Not found', { status: 404 });
    const requested = path.resolve(dist, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    const relative = path.relative(dist, requested);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(requested).href);
  });
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => callback(
    contents === window?.webContents && permission === 'media' && details.requestingUrl.startsWith('spur://app') &&
    (!('mediaTypes' in details) || !details.mediaTypes || details.mediaTypes.every(kind => kind === 'audio')) && dictation?.active === true,
  ));
  session.defaultSession.setPermissionCheckHandler((contents, permission, origin) => contents === window?.webContents && permission === 'media' && origin.startsWith('spur://app') && dictation?.active === true);
  window = new BrowserWindow({ width: 1280, height: 880, minWidth: 1000, minHeight: 720, show: false, frame: environment.mac, ...(environment.mac ? { titleBarStyle: 'hidden' as const } : {}),
    title: `Spur Desktop ${app.getVersion()}`, backgroundColor: '#F6F7F9', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, spellcheck: false, backgroundThrottling: false },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (!url.startsWith('spur://app/')) event.preventDefault(); });
  window.webContents.on('render-process-gone', () => { if (dictation.active) void dictation.fail(new Error('The interface closed; microphone capture stopped.')); });
  const validSender = (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) => event.sender === window?.webContents && event.senderFrame === window?.webContents.mainFrame;
  ipcMain.handle('spur:command', async (event, method, argument) => {
    if (!validSender(event)) throw new Error('Untrusted desktop request.');
    try { return await command(method, argument); }
    catch (error) { log(error instanceof Error ? error.message : 'Desktop operation failed.', true); throw error; }
  });
  ipcMain.on('spur:microphone', (event, pcm) => {
    if (!validSender(event) || !(pcm instanceof Uint8Array) || !pcm.length || pcm.length > 64000 || pcm.length % 2) return;
    dictation.audio(pcm);
  });
  ipcMain.on('spur:microphone-error', (event, message) => {
    if (validSender(event) && typeof message === 'string') void dictation.fail(new Error(`Microphone: ${message.slice(0, 400)}`));
  });
  await window.loadURL('spur://app/index.html');
  if (!selfTest) window.show();
}

async function verifyApp(): Promise<void> {
  const reportArgument = process.argv.indexOf('--report');
  const reportPath = reportArgument >= 0 ? process.argv[reportArgument + 1] : path.join(root, 'test-output', 'self-test.json');
  const result: Record<string, unknown> = { version: app.getVersion(), platform: process.platform, ui: false, service: false, noRendererNode: false, ringAuthenticated: false, transcriptionLiveVerified: false };
  diagnosticExitCode = 0;
  try {
    result.service = state.service.ready;
    if (environment.mac) {
      result.macNativeBindings = state.permissions?.accessibility.available === true;
      const bluetooth = await service.request('diagnose');
      result.coreBluetoothBindings = typeof bluetooth.bluetooth_authorization === 'string';
      result.bluetoothPermission = bluetooth.bluetooth_authorization || bluetooth.error;
    }
    await window!.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    result.noRendererNode = await window!.webContents.executeJavaScript('typeof require === "undefined" && typeof process === "undefined"');
    result.ui = await window!.webContents.executeJavaScript('Boolean(document.querySelector("main")) && document.body.innerText.toLowerCase().includes("spur")');
    result.pcmWorklet = await window!.webContents.executeJavaScript(`(async () => {
      // Offline rendering exercises the real worklet without an output device,
      // which is not guaranteed to exist on a hosted macOS build runner.
      const context = new OfflineAudioContext(1, 16000, 16000);
      let node;
      let timer;
      try {
        await context.audioWorklet.addModule('spur://app/pcm-worklet.js');
        node = new AudioWorkletNode(context, 'spur-pcm', { processorOptions: { inputRate: context.sampleRate } });
        const oscillator = context.createOscillator();
        const gain = context.createGain(); gain.gain.value = 0.1;
        oscillator.connect(gain).connect(node).connect(context.destination);
        const result = new Promise((resolve, reject) => {
          let chunks = 0;
          timer = setTimeout(() => reject(new Error('PCM worklet did not produce audio chunks.')), 6000);
          node.port.onmessage = event => {
            const samples = new Int16Array(event.data);
            if (samples.length !== 1600 || !samples.some(sample => sample !== 0)) { clearTimeout(timer); reject(new Error('Invalid PCM worklet output.')); return; }
            if (++chunks === 3) { clearTimeout(timer); resolve({ verified: true, sampleRate: context.sampleRate, chunkBytes: event.data.byteLength, syntheticAudioOnly: true }); }
          };
        });
        oscillator.start();
        const [, verified] = await Promise.all([context.startRendering(), result]);
        return verified;
      } finally { clearTimeout(timer); node?.disconnect(); node?.port.close(); }
    })()`, true);
    const testRing = process.argv.indexOf('--test-ring');
    if (testRing >= 0) {
      await command('scan');
      const address = process.argv[testRing + 1];
      await command('connect', address);
      result.ringAuthenticated = state.connection === 'connected';
      await command('disconnect');
    }
    const screenshot = await window!.webContents.capturePage();
    mkdirSync(path.dirname(reportPath), { recursive: true });
    writeFileSync(path.join(path.dirname(reportPath), 'desktop-preview.png'), screenshot.toPNG());
    result.settingsUI = await window!.webContents.executeJavaScript(`(async () => {
      const button = [...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Settings');
      button?.click();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await new Promise(resolve => setTimeout(resolve, 200));
      return Boolean(document.querySelector('input[type="password"]'));
    })()`);
    writeFileSync(path.join(path.dirname(reportPath), 'settings-preview.png'), (await window!.webContents.capturePage()).toPNG());
    if (!result.ui || !result.service || !result.noRendererNode || !result.settingsUI || (environment.mac && (!result.macNativeBindings || !result.coreBluetoothBindings)) || !(result.pcmWorklet as { verified?: boolean })?.verified) throw new Error('A packaged application check failed.');
  } catch (error) { result.error = error instanceof Error ? error.message : String(error); diagnosticExitCode = 1; }
  atomicJSON(reportPath, result);
  app.quit();
}

app.whenReady().then(async () => {
  loadSettings();
  if (environment.mac) Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Spur Desktop', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { role: 'windowMenu' },
  ]));
  dictation = new Dictation({ state, changed, log, request: service.request.bind(service), key: () => apiKey,
    excludedPids: () => [process.pid, ...(window ? [window.webContents.getOSProcessId()] : [])].filter(pid => pid > 0), sync, transcribe, prepareSession,
  });
  let serviceStarted: Promise<void>;
  try {
    service.start(app.isPackaged, process.resourcesPath, root, dataRoot);
    serviceStarted = service.request('getInfo').then(async () => { state.service = { ready: true }; await refreshLibrary(); await refreshPermissions(); changed(); });
  } catch (error) { state.service = { ready: false, error: String(error) }; serviceStarted = Promise.resolve(); }
  await createWindow();
  await serviceStarted.catch(error => { state.service = { ready: false, error: String(error) }; log(String(error), true); });
  if (selfTest) { await verifyApp(); return; }
  if (!globalShortcut.register('CommandOrControl+Shift+Space', () => {
    void (dictation.active ? dictation.stop() : dictation.start(0)).catch(error => log(String(error), true));
  })) log(`${settings.shortcut} is in use by another app. Use the Start button or change the other app’s shortcut.`, true);
}).catch(error => { if (!selfTest) dialog.showErrorBox('Spur could not start', error instanceof Error ? error.message : String(error)); app.quit(); });
app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  if (quitting) return;
  event.preventDefault(); quitting = true;
  globalShortcut.unregisterAll();
  void (async () => { await dictation?.stop().catch(() => {}); await service.close(); if (diagnosticExitCode !== undefined) app.exit(diagnosticExitCode); else app.quit(); })();
});
