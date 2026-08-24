// Check record status; resume-if-paused then stop any active recording.
import OBSWebSocket from 'obs-websocket-js';
const obs = new OBSWebSocket();
await obs.connect('ws://127.0.0.1:4455', process.env.OBS_WS_PASSWORD);
const st = await obs.call('GetRecordStatus');
console.log('status:', JSON.stringify(st));
if (st.outputPaused) {
  try {
    await obs.call('ResumeRecord');
    console.log('resumed OK');
  } catch (e) {
    console.log(`ResumeRecord failed: code=${e.code} message=${e.message}`);
  }
}
if (st.outputActive) {
  try {
    const r = await obs.call('StopRecord');
    console.log('stopped, outputPath:', r.outputPath);
  } catch (e) {
    console.log(`StopRecord failed: code=${e.code} message=${e.message}`);
  }
}
await obs.disconnect();
