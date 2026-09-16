import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
const root = mkdtempSync(join(tmpdir(), 'mirrors-e2e-'));
const init = spawnSync(process.execPath, ['dist/cli.js', 'demo', '--dir', root], {
  stdio: 'inherit',
});
if (init.status) process.exit(init.status);
const child = spawn(process.execPath, ['dist/cli.js', '--cwd', root, 'serve', '--port', '7439'], {
  stdio: 'inherit',
});
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    child.kill(signal);
  });
child.on('exit', (code) => process.exit(code ?? 0));
