// node-pty 1.1.0's macOS prebuilt spawn-helper may lack executable bits.
// Keep fresh installs runnable as well as locally compiled builds.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
if (process.platform === 'darwin') {
  const root = path.dirname(require.resolve('node-pty/package.json'));
  for (const relative of ['build/Release', 'build/Debug', `prebuilds/${process.platform}-${process.arch}`]) {
    const helper = path.join(root, relative, 'spawn-helper');
    if (!fs.existsSync(helper)) continue;
    const mode = fs.statSync(helper).mode;
    if ((mode & 0o111) !== 0o111) fs.chmodSync(helper, mode | 0o111);
  }
}
