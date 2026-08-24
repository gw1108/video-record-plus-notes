// Probe live OBS state over obs-websocket: versions, profile params, inputs.
import OBSWebSocket from 'obs-websocket-js';

const obs = new OBSWebSocket();
const password = process.env.OBS_WS_PASSWORD;
await obs.connect('ws://127.0.0.1:4455', password);

const out = {};
out.version = await obs.call('GetVersion');
delete out.version.availableRequests;

const params = [
  ['Output', 'Mode'],
  ['AdvOut', 'RecFormat2'],
  ['AdvOut', 'RecTracks'],
  ['AdvOut', 'RecEncoder'],
  ['SimpleOutput', 'RecFormat2'],
];
out.profile = {};
for (const [cat, name] of params) {
  try {
    const r = await obs.call('GetProfileParameter', { parameterCategory: cat, parameterName: name });
    out.profile[`${cat}/${name}`] = r.parameterValue;
  } catch (e) {
    out.profile[`${cat}/${name}`] = `ERROR: ${e.message}`;
  }
}
out.recordDirectory = (await obs.call('GetRecordDirectory')).recordDirectory;
out.recordStatus = await obs.call('GetRecordStatus');
out.specialInputs = await obs.call('GetSpecialInputs');
out.inputs = (await obs.call('GetInputList')).inputs.map((i) => ({
  name: i.inputName, kind: i.inputKind,
}));
for (const i of out.inputs) {
  try {
    const t = await obs.call('GetInputAudioTracks', { inputName: i.name });
    i.audioTracks = t.inputAudioTracks;
  } catch { /* not an audio input */ }
}
out.profiles = await obs.call('GetProfileList');
out.scenes = (await obs.call('GetSceneList')).scenes.map((s) => s.sceneName);

console.log(JSON.stringify(out, null, 2));
await obs.disconnect();
