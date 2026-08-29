/**
 * Renders the audit documents to PNG (and PDF) for the YouTube API compliance
 * form, which takes image or PDF uploads only.
 *
 *   npx electron verification/audit/render.mjs
 *
 * Chromium paints the pages; capturePage at deviceScaleFactor 2 gives a crisp
 * file well past the form's 720p minimum while staying far under its 10 MB cap.
 * An offscreen window composites lazily, so each capture waits for a frame
 * first (tasks/lessons.md).
 */
import { app, BrowserWindow } from 'electron';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, 'out');

/** Each page declares the canvas it was laid out for. */
const PAGES = [
  { file: 'architecture.html', name: 'playtest-recorder-architecture', width: 1600, height: 900 },
  { file: 'user-flow.html', name: 'playtest-recorder-user-flow', width: 1600, height: 900 },
  { file: 'supporting.html', name: 'playtest-recorder-api-usage', width: 1600, height: 1250 },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const report = [];

async function render(win, page) {
  win.setContentSize(page.width, page.height);
  await win.loadFile(join(__dirname, page.file));
  await sleep(900); // let fonts and layout settle before the first capture

  const image = await win.webContents.capturePage();
  const pngPath = join(OUT, `${page.name}.png`);
  writeFileSync(pngPath, image.toPNG());

  const pdf = await win.webContents.printToPDF({
    printBackground: true,
    pageSize: { width: page.width / 96, height: page.height / 96 }, // CSS px -> inches
    margins: { top: 0, bottom: 0, left: 0, right: 0 },
  });
  const pdfPath = join(OUT, `${page.name}.pdf`);
  writeFileSync(pdfPath, pdf);

  const size = image.getSize();
  report.push(
    `${page.name}.png  ${size.width}x${size.height}px  ${(statSync(pngPath).size / 1024).toFixed(0)} KB` +
      `   |   ${page.name}.pdf  ${(statSync(pdfPath).size / 1024).toFixed(0)} KB`,
  );
}

app.whenReady().then(async () => {
  mkdirSync(OUT, { recursive: true });
  // One window, resized per page: creating and destroying a window per page
  // makes the next loadFile fail with ERR_FAILED.
  const win = new BrowserWindow({
    width: 1600,
    height: 1250,
    show: false,
    webPreferences: { offscreen: false, backgroundThrottling: false },
  });
  try {
    for (const page of PAGES) await render(win, page);
    writeFileSync(join(OUT, 'render-report.txt'), `${report.join('\n')}\n`, 'utf8');
    app.exit(0);
  } catch (err) {
    writeFileSync(join(OUT, 'render-report.txt'), `FAILED: ${err?.stack ?? err}\n`, 'utf8');
    app.exit(1);
  }
});
