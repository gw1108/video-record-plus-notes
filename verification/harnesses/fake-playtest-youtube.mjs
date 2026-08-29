/**
 * A stand-in for `playtest-youtube` that speaks the same `--json` NDJSON
 * protocol, so the real `YouTubeUploader` (apps/recorder/dist/main/youtube.js)
 * can be driven through a whole upload — auth, chunked progress, done — without
 * touching Google or putting a video on a real channel.
 *
 *   node fake-playtest-youtube.mjs status --json
 *   node fake-playtest-youtube.mjs upload <dir> --json --privacy unlisted
 *
 * Scenarios come from FAKE_YT: 'ok' (default), 'browser' (a sign-in trip
 * first), 'error' (a quota failure), 'missing-libs', 'no-client'.
 */
const argv = process.argv.slice(2);
const command = argv[0] ?? '';
const scenario = process.env.FAKE_YT ?? 'ok';
const TOTAL = 239_463_709; // the golden-path condensed.mp4, byte for byte
const CHUNK = 8 * 1024 * 1024;

const emit = (event, fields = {}) => console.log(JSON.stringify({ event, ...fields }));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fail(message, hint) {
  emit('error', { message, hint: hint ?? '' });
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

if (command === 'status') {
  emit('status', {
    configDir: 'C:\\Users\\Example\\AppData\\Roaming\\playtest-recorder',
    client:
      scenario === 'no-client'
        ? { path: 'C:\\…\\youtube-client.json', ok: false, error: 'no OAuth client JSON', hint: 'run the M2.4 wizard' }
        : { path: 'C:\\…\\youtube-client.json', ok: true, clientId: '5248…apps.googleusercontent.com', project: 'videorecorderplusnotes' },
    token:
      scenario === 'browser'
        ? { path: 'C:\\…\\youtube-token.json', exists: false, expiry: null, expired: false, scopesOk: false, hasRefreshToken: false }
        : {
            path: 'C:\\…\\youtube-token.json',
            exists: true,
            expiry: new Date(Date.now() + 6 * 86_400_000).toISOString(),
            expired: false,
            scopesOk: true,
            hasRefreshToken: true,
          },
    libraries: scenario !== 'missing-libs',
    librariesHint: 'pip install -e "pipeline[youtube]"',
    audit: null,
    auditWarning:
      'the compliance audit has not passed (YOUTUBE_AUDIT_STATUS is unset) — YouTube will lock this upload to PRIVATE regardless of privacyStatus, and it stays uploadable/editable in Studio',
    ready: scenario === 'ok',
  });
  process.exit(0);
}

if (command === 'auth') {
  emit('auth-start', { clientId: '5248…apps.googleusercontent.com', scopes: ['https://www.googleapis.com/auth/youtube.upload'] });
  await sleep(400);
  emit('auth', { how: 'browser', tokenPath: 'C:\\…\\youtube-token.json', expiry: new Date(Date.now() + 6 * 86_400_000).toISOString() });
  process.exit(0);
}

if (command === 'logout') {
  emit('logout', { removed: true, tokenPath: 'C:\\…\\youtube-token.json', revokeUrl: 'https://myaccount.google.com/permissions' });
  process.exit(0);
}

if (command !== 'upload') fail(`unknown command ${command}`);

const privacy = argv.includes('--privacy') ? argv[argv.indexOf('--privacy') + 1] : 'unlisted';
emit('kit', { title: 'Fake session — playtest 2026-08-28', chapters: 8, bytes: TOTAL, privacy });
emit('auth-start');
if (scenario === 'browser') await sleep(1200); // the consent screen, in spirit
emit('auth', { how: scenario === 'browser' ? 'browser' : 'cached', tokenPath: 'C:\\…\\youtube-token.json' });
emit('upload-start', { bytes: TOTAL });

for (let sent = CHUNK; sent < TOTAL; sent += CHUNK) {
  if (scenario === 'error' && sent > TOTAL / 3) {
    fail('YouTube API error 403: The user has exceeded the number of videos they may upload.', 'the project\u2019s daily quota is spent — try again after the quota resets at midnight Pacific');
  }
  emit('progress', { sent, total: TOTAL });
  await sleep(90);
}
emit('progress', { sent: TOTAL, total: TOTAL });
emit('done', {
  videoId: 'FAKEvideoId1',
  url: 'https://youtu.be/FAKEvideoId1',
  studioUrl: 'https://studio.youtube.com/video/FAKEvideoId1/edit',
  // What the pending audit does to every upload: private, whatever we asked for.
  privacyStatus: 'private',
  requestedPrivacy: privacy,
  urlFile: 'report\\youtube\\url.txt',
});
