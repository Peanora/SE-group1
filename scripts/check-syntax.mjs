import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const files = ['server.mjs'];
for (const directory of ['lib', 'scripts', 'public', 'tests', 'examples']) {
  for (const file of await readdir(new URL(`../${directory}/`, import.meta.url))) {
    if (/\.(?:mjs|js)$/u.test(file)) files.push(`${directory}/${file}`);
  }
}
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) { process.exitCode = 1; break; }
}
if (!process.exitCode) console.log(`${files.length} 个脚本语法检查通过。`);
