// Copies the runtime files into dist/ (used as the Capacitor webDir and for static hosting).
import { cpSync, rmSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist');
rmSync(out, { recursive: true, force: true });
mkdirSync(out);
for (const f of ['index.html', 'styles.css', 'manifest.webmanifest', 'sw.js', 'assets', 'vendor', 'src']) {
  cpSync(join(root, f), join(out, f), { recursive: true });
}
console.log('Built dist/');
