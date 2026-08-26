// Empirically test PauseRecord behavior vs RecEncoder setting.
import OBSWebSocket from 'obs-websocket-js';
const obs = new OBSWebSocket();
await obs.connect('ws://127.0.0.1:4455', process.env.OBS_WS_PASSWORD);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const enc = process.argv[2]; // optional: set RecEncoder first
if (enc) {
  await obs.call('SetProfileParameter', { parameterCategory: 'AdvOut', parameterName: 'RecEncoder', parameterValue: enc });
  console.log(`RecEncoder set to ${enc}`);
}
obs.on('RecordStateChanged', (d) => console.log('event:', JSON.stringify(d)));
await obs.call('StartRecord');
await sleep(3000);
try {
  await obs.call('PauseRecord');
  console.log('PauseRecord: request OK');
} catch (e) {
  console.log(`PauseRecord threw: code=${e.code} message=${e.message}`);
}
await sleep(2000);
let st = await obs.call('GetRecordStatus');
console.log('after pause: paused =', st.outputPaused, 'duration =', st.outputDuration);
try {
  await obs.call('ResumeRecord');
  console.log('ResumeRecord: request OK');
} catch (e) {
  console.log(`ResumeRecord threw: code=${e.code} message=${e.message}`);
}
await sleep(2000);
st = await obs.call('GetRecordStatus');
console.log('after resume: paused =', st.outputPaused, 'active =', st.outputActive);
const r = await obs.call('StopRecord');
console.log('stopped:', r.outputPath);
await sleep(1000);
await obs.disconnect();
