// Copy renderer static assets (html/css) next to the compiled renderer JS.
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'dist', 'renderer');
mkdirSync(outDir, { recursive: true });
for (const file of ['index.html', 'style.css']) {
  cpSync(join(root, 'src', 'renderer', file), join(outDir, file));
}
console.log('copied renderer static assets ->', outDir);
