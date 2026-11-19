import { contextBridge, ipcRenderer } from 'electron';
import type { AppState, SpurAPI } from '../src/types';
const invoke = (method: string, ...args: unknown[]) => ipcRenderer.invoke('spur:command', method, ...args);
const api: SpurAPI = {
  getState: () => invoke('getState'),
  onState(callback) { const listener = (_event: unknown, state: AppState) => callback(state); ipcRenderer.on('spur:state', listener); return () => ipcRenderer.removeListener('spur:state', listener); },
  scan: () => invoke('scan'), connect: id => invoke('connect', id), disconnect: () => invoke('disconnect'), sync: () => invoke('sync'),
  openRecording: id => invoke('openRecording', id), exportRecording: id => invoke('exportRecording', id), openFolder: () => invoke('openFolder'),
  saveSettings: settings => invoke('saveSettings', settings), startDictation: () => invoke('startDictation'), stopDictation: () => invoke('stopDictation'),
  copyTranscript: () => invoke('copyTranscript'), clearTranscript: () => invoke('clearTranscript'), transcribeRecording: id => invoke('transcribeRecording', id),
  minimize: () => invoke('minimize'), close: () => invoke('close'),
  requestPermissions: () => invoke('requestPermissions'),
  sendMicrophoneChunk: pcm => ipcRenderer.send('spur:microphone', pcm), reportMicrophoneError: message => ipcRenderer.send('spur:microphone-error', message),
};
contextBridge.exposeInMainWorld('spur', api);
