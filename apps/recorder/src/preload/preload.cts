/**
 * Preload: exposes the typed PlaytestApi to the renderer via contextBridge.
 * Compiled to CommonJS (preload.cjs) so it works in a sandboxed renderer.
 */
import { contextBridge, ipcRenderer } from 'electron';
import type {
  PlaytestApi,
  RecorderConfig,
  RecorderPushEvent,
  StartSessionRequest,
} from '../common/ipc-contract.js';

const api: PlaytestApi = {
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (config: RecorderConfig) => ipcRenderer.invoke('config:set', config),
  obsConnect: () => ipcRenderer.invoke('obs:connect'),
  obsAutoDetect: () => ipcRenderer.invoke('obs:auto-detect'),
  obsPreflight: () => ipcRenderer.invoke('obs:preflight'),
  obsApplyRecommended: () => ipcRenderer.invoke('obs:apply-recommended'),
  startSession: (req: StartSessionRequest) => ipcRenderer.invoke('session:start', req),
  stopSession: () => ipcRenderer.invoke('session:stop'),
  getStatus: () => ipcRenderer.invoke('session:status'),
  onEvent: (callback: (event: RecorderPushEvent) => void) => {
    const listener = (_e: unknown, event: RecorderPushEvent) => callback(event);
    ipcRenderer.on('recorder:event', listener);
    return () => ipcRenderer.removeListener('recorder:event', listener);
  },
};

contextBridge.exposeInMainWorld('playtest', api);
