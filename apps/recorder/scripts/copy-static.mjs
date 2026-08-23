// Copy renderer static assets (html/css) next to the compiled renderer JS.
import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'dist', 'renderer');
mkdirSync(outDir, { recursive: true });
for (const file of ['index.html', 'style.css']) {
  cpSync(join(root, 'src', 'renderer', file), join(outDir, file));
}
// Guard the regression that made every button in the window dead: index.html
// is copied to dist/renderer/, so its <script src> is relative to THAT dir.
// A wrong path fails silently at runtime (module 404 → no listeners bound).
const html = readFileSync(join(outDir, 'index.html'), 'utf8');
const src = /<script[^>]*\ssrc="([^"]+)"/.exec(html)?.[1];
if (!src) throw new Error('index.html has no <script src>');
if (!existsSync(join(outDir, src))) {
  throw new Error(
    `index.html loads "${src}", which does not exist under ${outDir}. ` +
      'The path is relative to the copied HTML, not to src/renderer.',
  );
}

console.log('copied renderer static assets ->', outDir);
