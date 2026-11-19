import { useEffect, useMemo, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type { AppState, AudioSource, Settings, SpurAPI } from './types';
import { Icon } from './components/Icons';
import type { IconName } from './components/Icons';
import { Waveform } from './components/Waveform';

type Page = 'dictation' | 'recordings' | 'settings';
type SaveSettings = Parameters<SpurAPI['saveSettings']>[0];
type Action = (name: string, operation: () => Promise<void>, success?: string) => Promise<boolean>;

const CONNECTION_LABELS = { disconnected: 'Not connected', connecting: 'Connecting', authenticating: 'Authenticating', connected: 'Connected', syncing: 'Syncing' };
const LANGUAGES = [{ value: 'auto', label: 'Auto-detect language' }, { value: 'en', label: 'English' }, { value: 'zh', label: 'Chinese' }, { value: 'ja', label: 'Japanese' }, { value: 'ko', label: 'Korean' }, { value: 'es', label: 'Spanish' }, { value: 'fr', label: 'French' }, { value: 'de', label: 'German' }, { value: 'pt', label: 'Portuguese' }, { value: 'hi', label: 'Hindi' }];
const SOURCE_OPTIONS: { value: AudioSource; icon: IconName; title: string; description: string }[] = [
  { value: 'ring', icon: 'ring', title: 'Ring-controlled live', description: 'Your ring controls the computer microphone.' },
  { value: 'microphone', icon: 'mic', title: 'Computer microphone', description: 'Start live dictation with a shortcut.' },
  { value: 'ring-recording', icon: 'library', title: 'Ring microphone', description: 'Transcribe after the ring recording ends.' },
];

function sizeLabel(bytes: number) { return bytes < 1048576 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1048576).toFixed(1)} MB`; }
function dateLabel(timestamp: number) {
  const date = new Date(timestamp > 1e11 ? timestamp : timestamp * 1000);
  return Number.isNaN(date.getTime()) ? 'Date unavailable' : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function Spinner() { return <span className="spinner" aria-hidden="true" />; }
function IconButton({ icon, label, onClick, disabled = false, className = '' }: { icon: IconName; label: string; onClick: () => void; disabled?: boolean; className?: string }) {
  return <button type="button" className={`icon-button ${className}`} aria-label={label} title={label} onClick={onClick} disabled={disabled}><Icon name={icon} size={18} /></button>;
}
function StatusPill({ children, connected = false, subtle = false }: { children: ReactNode; connected?: boolean; subtle?: boolean }) {
  return <span className={`status-pill${connected ? ' connected' : ''}${subtle ? ' subtle' : ''}`}><span className="status-dot" />{children}</span>;
}
function KeyboardShortcut({ shortcut = 'Ctrl+Shift+Space' }: { shortcut?: string }) {
  return <span className="keyboard-shortcut" aria-label={shortcut}>{shortcut.split('+').map((key) => <kbd key={key}>{key}</kbd>)}</span>;
}

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [page, setPage] = useState<Page>('dictation');
  const [fatal, setFatal] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [activity, setActivity] = useState(false);

  useEffect(() => {
    const api = window.spur;
    if (!api) {
      setFatal('The desktop connection is unavailable. Open Spur from its desktop application to connect your ring and use dictation.');
      return;
    }
    let alive = true;
    let receivedUpdate = false;
    const unsubscribe = api.onState((next) => {
      receivedUpdate = true;
      if (alive) setState(next);
    });
    api.getState().then((next) => { if (alive && !receivedUpdate) setState(next); }).catch((reason: unknown) => {
      if (alive) setFatal(reason instanceof Error ? reason.message : 'Spur could not read the desktop application state.');
    });
    return () => { alive = false; unsubscribe(); };
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(''), 4500);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  const run: Action = async (name, operation, success) => {
    setError('');
    setPending(name);
    try {
      await operation();
      if (success) setNotice(success);
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Something went wrong. Please try again.');
      return false;
    } finally { setPending((current) => current === name ? null : current); }
  };

  const api = window.spur;
  const connected = state?.connection === 'connected' || state?.connection === 'syncing';
  const disabled = Boolean(pending || state?.busy);

  return <div className={`desktop-shell${state?.platform === 'macos' ? ' is-macos' : ''}`}>
    <aside className="sidebar" aria-label="Main navigation">
      <a className="brand" href="#dictation" onClick={(event) => { event.preventDefault(); setPage('dictation'); }} aria-label="Spur home"><span className="brand-symbol"><Icon name="brand" size={26} /></span><span>spur<span className="brand-period">.</span></span></a>
      <div className="sidebar-caption">A LITTLE MORE FLOW</div>
      <nav className="nav-items">
        {([{ id: 'dictation', icon: 'mic', label: 'Dictation' }, { id: 'recordings', icon: 'library', label: 'Recordings' }, { id: 'settings', icon: 'settings', label: 'Settings' }] as const).map((item) => <button key={item.id} type="button" className={`nav-item${page === item.id ? ' active' : ''}`} onClick={() => setPage(item.id)} aria-current={page === item.id ? 'page' : undefined}><Icon name={item.icon} size={20} /><span>{item.label}</span>{item.id === 'recordings' && state?.recordings.length ? <span className="nav-count">{state.recordings.length}</span> : null}</button>)}
      </nav>
      <div className="sidebar-bottom">
        <div className="sidebar-note"><span className="tiny-spark">✦</span><p>Less friction.<br /><strong>More you.</strong></p></div>
        <button type="button" className="sidebar-device" onClick={() => setPage('dictation')}><span className={`device-glyph${connected ? ' online' : ''}`}><Icon name="ring" size={21} /></span><span><strong>{connected ? state?.ringName || 'Spur Ring' : 'Your ring'}</strong><small><span className={`inline-dot${connected ? ' online' : ''}`} />{state ? CONNECTION_LABELS[state.connection] : 'Waiting for desktop'}</small></span><Icon name="chevron" size={15} /></button>
        <span className="version">SPUR DESKTOP <span>{state ? `v${state.version}` : ''}</span></span>
      </div>
    </aside>

    <div className="app-body">
      <div className="titlebar"><span><span className="titlebar-dot" />Your space to think</span><div className="window-controls"><button type="button" aria-label="Minimize window" onClick={() => api && void api.minimize()} disabled={!api}><Icon name="minus" size={15} /></button><button type="button" aria-label="Close window" onClick={() => api && void api.close()} disabled={!api}><Icon name="close" size={15} /></button></div></div>
      <main className="main-content" id="main-content">
        <header className="page-header"><div><div className="eyebrow">{page === 'dictation' ? 'YOUR VOICE, IN FLOW' : page === 'recordings' ? 'KEEP THE GOOD THOUGHTS' : 'MAKE YOURSELF AT HOME'}</div><h1>{page === 'dictation' ? 'A thought away.' : page === 'recordings' ? 'Your recordings.' : 'Just your way.'}</h1><p>{page === 'dictation' ? 'From a passing thought to words on your screen.' : page === 'recordings' ? 'The moments you captured. Ready for what comes next.' : 'A few small choices. A smoother everyday flow.'}</p></div><div className="eleven-badge"><span className="eleven-logo" aria-hidden="true">Ⅱ</span><span>Speech by<strong>ElevenLabs</strong></span></div></header>

        {fatal ? <div className="unavailable-state" role="alert"><span className="unavailable-icon"><Icon name="cloud" size={32} /></span><h2>Let’s reconnect to desktop.</h2><p>{fatal}</p></div> : !state ? <div className="loading-state" role="status"><Spinner /><span>Opening your space…</span></div> : <>
          {error ? <div className="message-banner error-banner" role="alert"><Icon name="info" size={18} /><span>{error}</span><IconButton icon="close" label="Dismiss error" onClick={() => setError('')} /></div> : null}
          {!state.service.ready ? <div className="message-banner service-banner" role="status"><Icon name="info" size={18} /><span>{state.service.error || 'The ring service is starting. Bluetooth controls will be available when it is ready.'}</span><button className="text-button" type="button" onClick={() => setActivity(true)}>View activity<Icon name="arrow" size={15} /></button></div> : null}
          {page === 'dictation' ? <div className="workspace-grid"><div className="dictation-column"><DictationPanel state={state} disabled={disabled} pending={pending} run={run} onSettings={() => setPage('settings')} /><TranscriptPanel state={state} disabled={disabled} run={run} /></div><div className="context-column"><RingPanel state={state} disabled={disabled} pending={pending} run={run} /><FlowGuide source={state.settings.source} shortcut={state.settings.shortcut} /></div></div> : page === 'recordings' ? <RecordingsPage state={state} disabled={disabled} pending={pending} run={run} /> : <SettingsPage settings={state.settings} disabled={disabled || !['idle', 'error'].includes(state.dictation.status)} pending={pending} onSave={(settings) => run('save-settings', () => api.saveSettings(settings), 'Your preferences are saved.')} />}
          <footer className="workspace-footer"><span><Icon name="shield" size={14} />Your recordings stay on this computer. Transcription uses ElevenLabs.</span><button type="button" className={`activity-toggle${activity ? ' expanded' : ''}`} onClick={() => setActivity((open) => !open)} aria-expanded={activity}><span className="inline-dot" />Activity<Icon name="chevron" size={12} /></button></footer>
          {activity ? <section className="activity-panel" aria-label="Application activity"><div className="activity-header"><h2>Behind the scenes</h2><span>{state.logs.length} events</span></div>{state.logs.length ? <ol>{state.logs.slice(-80).map((entry) => <li className={entry.level === 'error' ? 'log-error' : ''} key={entry.id}><time>{entry.time}</time><span>{entry.message}</span></li>)}</ol> : <p>No activity yet. Connection and dictation updates will appear here.</p>}</section> : null}
        </>}
      </main>
    </div>
    {notice ? <div className="toast" role="status"><span><Icon name="check" size={16} /></span>{notice}</div> : null}
  </div>;
}

function DictationPanel({ state, disabled, pending, run, onSettings }: { state: AppState; disabled: boolean; pending: string | null; run: Action; onSettings: () => void }) {
  const source = state.settings.source;
  const ringControl = source === 'ring';
  const ringRecording = source === 'ring-recording';
  const ringSource = source !== 'microphone';
  const listening = state.dictation.status === 'listening';
  const armed = state.dictation.status === 'armed';
  const starting = state.dictation.status === 'starting';
  const stopping = state.dictation.status === 'stopping';
  const active = listening || armed || starting || stopping;
  const ringConnected = state.connection === 'connected' || state.connection === 'syncing';
  const needsKey = !state.settings.hasApiKey;
  const needsRing = ringSource && !ringConnected;
  const stopPending = pending === 'stop-dictation';
  const busy = starting || stopping || pending === 'start-dictation' || stopPending;
  const status = starting ? 'Getting ready…' : stopping ? 'Finishing your thought…' : armed ? (ringRecording ? 'Watching for new ring recordings' : 'Armed · Press your ring to speak') : listening ? (ringRecording ? 'Recording with your ring’s microphone' : 'Listening to your computer microphone') : 'A little space for your next idea';
  const button = stopPending ? 'Stopping dictation…' : starting || stopping ? 'Cancel dictation' : active ? (ringSource ? 'Disarm ring dictation' : 'Stop dictation') : needsKey ? 'Set up ElevenLabs' : needsRing ? 'Find your ring' : ringSource ? 'Arm ring dictation' : 'Start dictation';
  const handleClick = () => {
    if (active) { void run('stop-dictation', () => window.spur.stopDictation()); return; }
    if (needsKey) { onSettings(); return; }
    if (needsRing) { void run('scan', () => window.spur.scan()); return; }
    void run('start-dictation', () => window.spur.startDictation());
  };
  const setSource = (next: AudioSource) => { void run('source', () => window.spur.saveSettings({ source: next, language: state.settings.language, insertAtCursor: state.settings.insertAtCursor })); };

  return <section className={`dictation-hero${listening ? ' active' : ''}`} aria-label="Dictation controls">
    <div className="hero-top"><div className="source-switch" aria-label="Audio source"><button type="button" aria-pressed={ringControl} onClick={() => setSource('ring')} disabled={disabled || active}><Icon name="ring" size={15} />Ring control</button><button type="button" aria-pressed={!ringSource} onClick={() => setSource('microphone')} disabled={disabled || active}><Icon name="mic" size={14} />Computer mic</button><button type="button" aria-pressed={ringRecording} onClick={() => setSource('ring-recording')} disabled={disabled || active}><Icon name="library" size={14} />Ring audio</button></div></div>
    <div className="hero-center"><div className={`capture-symbol${listening ? ' capture-active' : ''}`}><span className="capture-orbit orbit-one" /><span className="capture-orbit orbit-two" /><span className="capture-icon"><Icon name={ringSource ? 'ring' : 'mic'} size={29} /></span>{listening || armed ? <span className="capture-live-dot" /> : null}</div><h2>{listening && !ringRecording ? <>Go on.<br />We’re all ears.</> : armed ? <>One touch.<br />A little more flow.</> : <>Think it.<br />Say it. Keep going.</>}</h2><p>{ringControl ? 'Your ring is the remote. Press to start and release to finish live dictation through your computer’s microphone.' : ringRecording ? 'Finish a recording on your ring. New ring-microphone recordings are transcribed and inserted automatically.' : 'Speak naturally. See your words appear in the window where you’re working.'}</p></div>
    <Waveform active={listening && !ringRecording} processing={starting || stopping} level={state.dictation.level} />
    <div className="capture-status" aria-live="polite"><span className={`inline-dot${listening ? ' online pulsing' : ''}`} />{status}</div>
    <button type="button" className={`capture-button${active ? ' is-stop' : ''}`} onClick={handleClick} disabled={active ? stopPending : disabled || (!state.service.ready && ringSource)}>{busy ? <Spinner /> : <Icon name={active ? 'stop' : needsKey ? 'bolt' : needsRing ? 'bluetooth' : 'mic'} size={18} />}{button}{!active && !needsKey && !needsRing ? <Icon name="arrow" size={17} /> : null}</button>
    <div className="hero-shortcut"><KeyboardShortcut shortcut={state.settings.shortcut} /><span>{starting && !ringSource ? 'Switch to the window you want to type in.' : ringSource ? 'to arm or disarm, from anywhere' : 'to start or stop, from anywhere'}</span></div>
    <div className="hero-bottom"><span><Icon name={state.settings.insertAtCursor ? 'cursor' : 'speech'} size={13} />{state.settings.insertAtCursor ? 'Insert at cursor' : 'Transcript only'}</span><span><Icon name={ringRecording ? 'ring' : 'mic'} size={13} />{ringRecording ? 'Ring microphone' : 'Computer microphone'}</span></div>
    {state.dictation.error ? <p className="dictation-error" role="alert">{state.dictation.error}</p> : null}
  </section>;
}

function TranscriptPanel({ state, disabled, run }: { state: AppState; disabled: boolean; run: Action }) {
  const { committed, partial } = state.transcript;
  const dictationActive = !['idle', 'error'].includes(state.dictation.status);
  const hasText = Boolean(committed || partial);
  const wordCount = committed.trim() ? committed.trim().split(/\s+/).length : 0;
  return <section className="transcript-card panel" aria-label="Live transcript"><div className="panel-header"><div><span className="section-overline">THE WORDS AS THEY COME</span><h2>Your transcript<span className="subtle-dot">.</span></h2></div><div className="panel-actions"><IconButton icon="copy" label="Copy transcript" onClick={() => void run('copy', () => window.spur.copyTranscript(), 'Transcript copied to your clipboard.')} disabled={disabled || !committed} /><IconButton icon="trash" label="Clear transcript" onClick={() => void run('clear', () => window.spur.clearTranscript())} disabled={disabled || !hasText || dictationActive} /></div></div><div className={`transcript-content${hasText ? ' has-text' : ''}`} role="log" aria-label="Dictation transcript" aria-live="polite" aria-relevant="text">{hasText ? <p>{committed}<span className="partial-transcript">{partial}</span>{state.dictation.status === 'listening' ? <span className="typing-caret" /> : null}</p> : <div className="transcript-placeholder"><span className="text-line long" /><span className="text-line" /><span className="text-line short" /><p>Give that thought somewhere to land.<br /><span>Your words will appear here.</span></p></div>}</div><div className="transcript-footer"><span>{hasText ? `${wordCount} ${wordCount === 1 ? 'word' : 'words'}` : 'A fresh page, just for you'}</span><span>{state.dictation.targetLabel ? <><Icon name="cursor" size={12} />{state.dictation.targetLabel}</> : <><Icon name="speech" size={12} />{state.settings.insertAtCursor ? 'Focus your destination before starting' : 'Transcript preview'}</>}</span></div></section>;
}

function RingPanel({ state, disabled, pending, run }: { state: AppState; disabled: boolean; pending: string | null; run: Action }) {
  const dictationActive = !['idle', 'error'].includes(state.dictation.status);
  const connected = state.connection === 'connected' || state.connection === 'syncing';
  const connecting = state.connection === 'connecting' || state.connection === 'authenticating';
  const scanning = pending === 'scan' || state.busy === 'scanning';
  return <section className="ring-panel panel" aria-label="Ring connection"><div className="ring-card-header"><span className="section-overline">YOUR EVERYDAY COMPANION</span><StatusPill connected={connected}>{CONNECTION_LABELS[state.connection]}</StatusPill></div><div className={`ring-scene${connected ? ' connected' : ''}`} aria-hidden="true"><span className="ring-halo halo-one" /><span className="ring-halo halo-two" /><div className="ring-object"><span /><i /></div><span className="ring-shadow" /></div><h2>{connected ? state.ringName || 'Spur Ring' : 'Small ring. Big ideas.'}</h2><p>{connected ? 'A little closer to your next good thought.' : 'Bring your ring nearby and connect it to your computer.'}</p><div className="ring-primary-actions">{connected ? <><button type="button" className="button secondary" onClick={() => void run('sync', () => window.spur.sync(), 'Your recordings are up to date.')} disabled={disabled || dictationActive || !state.service.ready}>{state.connection === 'syncing' ? <Spinner /> : <Icon name="refresh" size={16} />}{state.connection === 'syncing' ? 'Syncing…' : 'Sync recordings'}</button><button type="button" className="text-button muted" onClick={() => void run('disconnect', () => window.spur.disconnect())} disabled={disabled || dictationActive}>Disconnect</button></> : <button type="button" className="button secondary" onClick={() => void run('scan', () => window.spur.scan())} disabled={disabled || connecting || !state.service.ready}>{scanning || connecting ? <Spinner /> : <Icon name="bluetooth" size={17} />}{scanning ? 'Looking nearby…' : connecting ? 'Connecting…' : 'Find your ring'}</button>}</div>{state.connection === 'syncing' ? <div className="sync-progress"><div><span style={{ width: `${Math.min(100, Math.max(0, state.progress))}%` }} /></div><small>{Math.round(state.progress)}% complete</small></div> : null}
    {!connected && state.devices.length ? <div className="nearby-devices"><div className="section-overline">NEARBY DEVICES</div>{state.devices.map((device) => <div className={`nearby-device${!device.compatible ? ' incompatible' : ''}`} key={device.id}><span className="nearby-icon"><Icon name={device.compatible ? 'ring' : 'bluetooth'} size={17} /></span><span><strong>{device.name || 'Unnamed device'}</strong><small>{device.compatible ? `${device.rssi} dBm · AIZO ring` : 'Not a supported ring'}</small></span><button type="button" className="text-button" onClick={() => void run('connect', () => window.spur.connect(device.id))} disabled={disabled || !device.compatible || connecting}>Connect</button></div>)}</div> : null}
    <div className="ring-footnote"><Icon name="bluetooth" size={13} />Connect directly over Bluetooth · No phone needed</div>
  </section>;
}

function FlowGuide({ source, shortcut }: { source: AudioSource; shortcut: string }) {
  return <section className="flow-guide"><span className="section-overline">A LITTLE LESS FRICTION</span><h3>Stay in your flow.</h3><ol><li><span>01</span><p>{source === 'ring' ? 'Arm ring control, then focus the document where you want to write.' : source === 'ring-recording' ? 'Arm dictation, then capture a thought with your ring’s microphone.' : <>Start dictation with <strong>{shortcut.replaceAll('+', ' + ')}</strong>.</>}</p></li><li><span>02</span><p>{source === 'ring' ? 'Press your ring to speak. Your computer microphone listens.' : source === 'ring-recording' ? 'Finish the ring recording. Spur picks up the new audio.' : 'Put your cursor in a document, message, or anywhere you write.'}</p></li><li><span>03</span><p>{source === 'ring' ? 'Release to finish. Your words land at your cursor.' : source === 'ring-recording' ? 'ElevenLabs turns the recording into words at your cursor.' : 'Speak your mind. Your words follow along.'}</p></li></ol><div className="guide-tip"><Icon name={source === 'microphone' ? 'cursor' : source === 'ring' ? 'mic' : 'ring'} size={15} /><p>{source === 'microphone' ? 'Starting from the app? You have 3 seconds to focus your destination.' : source === 'ring' ? 'The ring is your remote. Live audio comes from this computer’s microphone.' : 'Uses your ring’s microphone. Transcription begins after a recording finishes.'}</p></div></section>;
}

function RecordingsPage({ state, disabled, pending, run }: { state: AppState; disabled: boolean; pending: string | null; run: Action }) {
  const [query, setQuery] = useState('');
  const recordings = useMemo(() => { const search = query.trim().toLocaleLowerCase(); return search ? state.recordings.filter((recording) => `${recording.name} ${recording.transcript || ''}`.toLocaleLowerCase().includes(search)) : state.recordings; }, [state.recordings, query]);
  const connected = state.connection === 'connected';
  const dictationActive = !['idle', 'error'].includes(state.dictation.status);
  return <section className="recordings-page"><div className="library-toolbar"><div className="library-count"><span>{state.recordings.length}</span> {state.recordings.length === 1 ? 'recording' : 'recordings'} on this computer</div><div><button type="button" className="button secondary" onClick={() => void run('folder', () => window.spur.openFolder())} disabled={disabled}><Icon name="folder" size={17} />Open folder</button><button type="button" className="button primary" onClick={() => void run('sync', () => window.spur.sync(), 'Your recordings are up to date.')} disabled={disabled || !connected || dictationActive}>{pending === 'sync' || state.connection === 'syncing' ? <Spinner /> : <Icon name="refresh" size={17} />}Sync recordings</button></div></div><div className="library-panel panel"><div className="library-panel-header"><h2>Collected thoughts<span className="subtle-dot">.</span></h2><label className="search-field"><Icon name="search" size={17} /><input type="search" placeholder="Find a recording…" aria-label="Search recordings and transcripts" value={query} onChange={(event) => setQuery(event.target.value)} /></label></div>{recordings.length ? <div className="recording-table-scroll"><table className="recording-table"><thead><tr><th scope="col">RECORDING</th><th scope="col">CAPTURED</th><th scope="col">SIZE</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead><tbody>{recordings.map((recording) => <tr key={recording.id}><td><div className="recording-title"><span className="recording-file-icon"><Icon name="speech" size={20} /></span><span><strong>{recording.name}</strong><small>{recording.transcript ? 'Transcript available' : 'Ready to listen'}</small></span></div></td><td>{dateLabel(recording.timestamp)}</td><td>{sizeLabel(recording.size)}</td><td><div className="recording-actions"><IconButton icon="play" label={`Play ${recording.name}`} onClick={() => void run(`play-${recording.id}`, () => window.spur.openRecording(recording.id))} disabled={disabled} /><IconButton icon="speech" label={`Transcribe ${recording.name}`} onClick={() => void run(`transcribe-${recording.id}`, () => window.spur.transcribeRecording(recording.id), 'Recording transcribed. Find the words in Dictation.')} disabled={disabled || !state.settings.hasApiKey || dictationActive} /><IconButton icon="download" label={`Export ${recording.name}`} onClick={() => void run(`export-${recording.id}`, () => window.spur.exportRecording(recording.id))} disabled={disabled} /></div></td></tr>)}</tbody></table></div> : <div className="library-empty"><div className="empty-recording-art" aria-hidden="true"><span className="empty-sheet sheet-back" /><span className="empty-sheet sheet-front"><Icon name="speech" size={28} /><i /><i /><i /></span><span className="empty-spark">✦</span></div><h3>{query ? 'That thought isn’t here yet.' : 'Good thoughts deserve a home.'}</h3><p>{query ? 'Try another name or a word from the transcript.' : 'Connect your ring and sync your recordings. Everything you capture will have a place here.'}</p>{query ? <button type="button" className="text-button" onClick={() => setQuery('')}>Clear search<Icon name="arrow" size={16} /></button> : <span className="empty-library-note"><Icon name="shield" size={14} />Saved locally. Yours to keep.</span>}</div>}</div></section>;
}

function SettingsPage({ settings, disabled, pending, onSave }: { settings: Settings; disabled: boolean; pending: string | null; onSave: (settings: SaveSettings) => Promise<boolean> }) {
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [language, setLanguage] = useState(settings.language);
  const [source, setSource] = useState(settings.source);
  const [insertAtCursor, setInsertAtCursor] = useState(settings.insertAtCursor);
  const [permissionMessage, setPermissionMessage] = useState('');
  const [permissionPending, setPermissionPending] = useState(false);
  const requestPermissions = async () => {
    setPermissionPending(true);
    try {
      await window.spur.requestPermissions();
      const current = await window.spur.getState();
      setPermissionMessage(`Microphone: ${current.permissions?.microphone || 'unknown'}. Cursor typing: ${current.permissions?.accessibility.granted ? 'allowed' : 'enable Accessibility in System Settings → Privacy & Security'}.`);
    } catch (error) { setPermissionMessage(error instanceof Error ? error.message : 'Could not check macOS permissions.'); }
    finally { setPermissionPending(false); }
  };
  useEffect(() => { setLanguage(settings.language); setSource(settings.source); setInsertAtCursor(settings.insertAtCursor); }, [settings.language, settings.source, settings.insertAtCursor]);
  const submit = async (event: FormEvent) => { event.preventDefault(); const saved = await onSave({ apiKey: apiKey.trim() || undefined, language, source, insertAtCursor }); if (saved) { setApiKey(''); setShowKey(false); } };
  return <form className="settings-layout" onSubmit={(event) => void submit(event)}>
    <div className="settings-main">
      <section className="settings-card panel">
        <div className="settings-section-heading">
          <span className="settings-icon"><span className="eleven-logo">Ⅱ</span></span>
          <div><h2>A voice-to-words connection.</h2><p>Bring your ElevenLabs key. We’ll take it from there.</p></div>
          <StatusPill connected={settings.hasApiKey}>{settings.hasApiKey ? 'Key saved' : 'Not set up'}</StatusPill>
        </div>
        <div className="settings-section-body">
          <label className="field-label" htmlFor="api-key">ElevenLabs API key</label>
          <div className="key-field">
            <input id="api-key" type={showKey ? 'text' : 'password'} value={apiKey} onChange={(event) => setApiKey(event.target.value)} disabled={disabled} autoComplete="off" autoCorrect="off" spellCheck={false} placeholder={settings.hasApiKey ? 'Enter a new key to replace your saved key' : 'Paste your ElevenLabs API key'} aria-describedby="key-help" />
            <IconButton icon={showKey ? 'eyeoff' : 'eye'} label={showKey ? 'Hide API key' : 'Show API key'} onClick={() => setShowKey((show) => !show)} disabled={disabled} />
          </div>
          <p className="field-help" id="key-help"><Icon name="shield" size={13} />Protected by {settings.credentialStore || 'your operating system'} and saved only on this computer.</p>
          <div className="cloud-note"><Icon name="cloud" size={19} /><p>Audio is sent to ElevenLabs for transcription. Usage is billed to your ElevenLabs account.</p></div>
        </div>
      </section>
      {settings.credentialStore === 'macOS Keychain' ? <section className="settings-card panel">
        <div className="settings-section-heading"><span className="settings-icon"><Icon name="shield" size={21} /></span><div><h2>Allow dictation on your Mac.</h2><p>Microphone access captures speech. Accessibility lets Spur type at your cursor.</p></div></div>
        <div className="settings-section-body"><p className="field-help">In System Settings → Privacy &amp; Security, allow Bluetooth for the ring and Accessibility for Spur Desktop and its ring helper, if listed.</p><button type="button" className="button secondary" disabled={disabled || permissionPending} onClick={() => void requestPermissions()}>{permissionPending ? 'Checking permissions…' : 'Check / enable permissions'}</button>{permissionMessage ? <p className="field-help" role="status">{permissionMessage}</p> : null}</div>
      </section> : null}
      <section className="settings-card panel">
        <div className="settings-section-heading"><span className="settings-icon"><Icon name="mic" size={21} /></span><div><h2>The way you capture.</h2><p>Choose what works for the moment.</p></div></div>
        <div className="settings-section-body">
          <div className="field-label" id="source-label">Your audio source</div>
          <div className="source-options" role="group" aria-labelledby="source-label">
            {SOURCE_OPTIONS.map((option) => <button type="button" key={option.value} className={source === option.value ? 'selected' : ''} aria-pressed={source === option.value} onClick={() => setSource(option.value)} disabled={disabled}>
              <span className="source-option-top"><Icon name={option.icon} size={22} /><span className="radio-indicator">{source === option.value ? <span /> : null}</span></span>
              <strong>{option.title}</strong><small>{option.description}</small>
            </button>)}
          </div>
          <label className="field-label language-label" htmlFor="language">Transcription language</label>
          <div className="select-wrap"><select id="language" value={language} onChange={(event) => setLanguage(event.target.value)} disabled={disabled}>{LANGUAGES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select><Icon name="chevron" size={15} /></div>
          <div className="setting-toggle-row"><span><strong>Write where my cursor is</strong><small>Insert completed words into your active window.</small></span><button type="button" className={`toggle${insertAtCursor ? ' on' : ''}`} role="switch" aria-checked={insertAtCursor} aria-label="Insert dictated text at cursor" onClick={() => setInsertAtCursor((value) => !value)} disabled={disabled}><span /></button></div>
        </div>
      </section>
      <div className="settings-save-row"><span><Icon name="check" size={14} />Make it yours. Change it anytime.</span><button type="submit" className="button primary" disabled={disabled}>{pending === 'save-settings' ? <Spinner /> : <Icon name="check" size={17} />}Save preferences</button></div>
    </div>
    <aside className="settings-aside">
      <span className="shortcut-art"><Icon name="bolt" size={24} /></span><div className="section-overline">ONE SHORTCUT. MORE FLOW.</div><h3>Good thoughts<br />don’t wait.</h3>
      <p>Start or stop dictation from any app. Keep your cursor where you want your words to go.</p><KeyboardShortcut shortcut={settings.shortcut} />
      <div className="settings-aside-rule" /><span className="section-overline">A NOTE ON RING AUDIO</span>
      <p>Your ring can control live dictation through your computer’s microphone. Its own microphone is available through completed ring recordings.</p>
    </aside>
  </form>;
}
