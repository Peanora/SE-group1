import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { applyProjectFiles, readProjectFiles, validateProjectFiles } from '../lib/project-files.mjs';

async function setup(t) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'project-files-'));
  const workspace = path.join(parent, 'workspace');
  await fs.mkdir(workspace);
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  return { workspace, parent };
}
const file = (relative, content = 'export const value = 1;') => ({ path: relative, content });

test('规范化多文件建议仅保留path/content，按路径排序但不改内容', () => {
  const files = validateProjectFiles([{ ...file('src/app.mjs', '\uFEFFconst 名称 = "✓";\r\n'), passed: true }, file('public/index.html', '<!doctype html>')]);
  assert.deepEqual(files.map(item => item.path), ['public/index.html', 'src/app.mjs']);
  assert.equal(files[1].content, '\uFEFFconst 名称 = "✓";\r\n');
  assert.equal(files[1].passed, undefined);
  assert.deepEqual(validateProjectFiles([]), []);
});

test('拒绝越界、保留目录、Windows保留名、ADS及编码歧义', () => {
  const invalid = ['/src/a.mjs', 'C:/src/a.mjs', '//host/share/a.js', '../src/a.js', 'src/../a.js', 'src//a.js', 'src/./a.js', 'src\\a.js', 'src/a\0.js', 'src/%2e%2e/a.js', 'src/a.js:stream', 'src/NUL.txt', 'src/con.mjs', 'src/COM1.js', 'src/LPT¹.txt', 'src/a./b.js', 'src/a /b.js', 'src/.git/a.js', 'src/node_modules/a.js', 'src/.platform/a.js', 'package.json', 'package-lock.json', 'server.mjs', '.platform/protocol.cjs', '.git/config', 'node_modules/a.js', 'src/a.exe', 'src/a.png', 'src/a.JS', 'README.md/x.js'];
  for (const relative of invalid) assert.throws(() => validateProjectFiles([file(relative)]), { message: /文件/u }, relative);
  assert.throws(() => validateProjectFiles([file('src/a.js'), file('src/A.js')]), /重复/u);
  assert.throws(() => validateProjectFiles([file('src/σ.js'), file('src/ς.js')]), /重复/u);
  assert.throws(() => validateProjectFiles([file('src/\ud800.js')]), /路径/u);
  assert.throws(() => validateProjectFiles([file('src/a.js'), file('src/a.js/b.js')]), /冲突/u);
});

test('大小和数量按UTF-8字节限制，拒绝二进制与非法Unicode', () => {
  assert.equal(validateProjectFiles([file('src/a.txt', 'x'.repeat(128 * 1024))]).length, 1);
  assert.throws(() => validateProjectFiles([file('src/a.txt', 'x'.repeat(128 * 1024 + 1))]), /128 KiB/u);
  assert.throws(() => validateProjectFiles([file('src/a.txt', '汉'.repeat(44 * 1024))]), /128 KiB/u);
  assert.throws(() => validateProjectFiles(Array.from({ length: 17 }, (_, index) => file(`src/${index}.txt`, 'x'.repeat(128 * 1024)))), /2 MiB/u);
  assert.throws(() => validateProjectFiles(Array.from({ length: 61 }, (_, index) => file(`src/${index}.js`))), /60/u);
  for (const content of ['binary\0data', '\ud800', '\x1b[31m']) assert.throws(() => validateProjectFiles([file('src/a.js', content)]), /纯文本/u);
});

test('实际写入及读取多文件，不执行候选；无变化不会重写源文件', async t => {
  const { workspace } = await setup(t);
  const files = [file('src/app.mjs'), file('public/index.html', '<script src="/app.js"></script>'), file('public/app.js', 'document.title="课程";'), file('migrations/001.sql', 'CREATE TABLE items (id INTEGER);'), file('README.md', '运行说明')];
  const first = await applyProjectFiles({ workspace, files });
  assert.deepEqual(first.changed, validateProjectFiles(files).map(item => item.path));
  assert.deepEqual(first.unchanged, []);
  assert.match(first.sourceHash, /^[a-f0-9]{64}$/u);
  assert.deepEqual(await readProjectFiles(workspace), validateProjectFiles(files));
  const before = await fs.stat(path.join(workspace, 'src/app.mjs'));
  const second = await applyProjectFiles({ workspace, files });
  assert.deepEqual(second.changed, []);
  assert.equal(second.sourceHash, first.sourceHash);
  const after = await fs.stat(path.join(workspace, 'src/app.mjs'));
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeMs, before.mtimeMs);
  const changed = await applyProjectFiles({ workspace, files: [file('src/app.mjs', 'export const value = 2;')] });
  assert.notEqual(changed.sourceHash, first.sourceHash);
  assert.equal((await readProjectFiles(workspace)).length, files.length);
  assert.equal((await applyProjectFiles({ workspace, files: [] })).sourceHash, changed.sourceHash);
});

test('整批无效先拒绝，不创建先前合法文件或目录', async t => {
  const { workspace } = await setup(t);
  await assert.rejects(applyProjectFiles({ workspace, files: [file('src/a.js'), file('../outside.js')] }), /文件/u);
  assert.deepEqual(await fs.readdir(workspace), []);
  await fs.writeFile(path.join(workspace, 'src'), '现有未知文件');
  await assert.rejects(applyProjectFiles({ workspace, files: [file('public/a.js'), file('src/a.js')] }), /目录/u);
  assert.deepEqual(await fs.readdir(workspace), ['src']);
  assert.equal(await fs.readFile(path.join(workspace, 'src'), 'utf8'), '现有未知文件');
});

test('读取只含允许普通源码，排除平台、Git、依赖、数据库和临时残留', async t => {
  const { workspace } = await setup(t);
  await applyProjectFiles({ workspace, files: [file('src/app.mjs'), file('README.md', '说明')] });
  for (const directory of ['.platform', '.git', 'node_modules', 'src/node_modules']) await fs.mkdir(path.join(workspace, directory), { recursive: true });
  for (const relative of ['package.json', 'server.mjs', '.platform/private.mjs', '.git/secret.js', 'node_modules/secret.js', 'src/node_modules/secret.js', 'src/data.db', 'src/.project-write-leftover.tmp', '.env']) await fs.writeFile(path.join(workspace, relative), 'private');
  assert.deepEqual((await readProjectFiles(workspace)).map(item => item.path), ['README.md', 'src/app.mjs']);
  await applyProjectFiles({ workspace, files: [file('public/a.css', 'body {}')] });
  assert.equal(await fs.readFile(path.join(workspace, 'src/data.db'), 'utf8'), 'private');
});

test('既有大小写冲突原子拒绝', async t => {
  const { workspace } = await setup(t);
  await fs.mkdir(path.join(workspace, 'src'));
  await fs.writeFile(path.join(workspace, 'src/A.js'), '原始内容');
  await assert.rejects(applyProjectFiles({ workspace, files: [file('public/a.js'), file('src/a.js')] }), /冲突/u);
  assert.equal(await fs.readFile(path.join(workspace, 'src/A.js'), 'utf8'), '原始内容');
  await assert.rejects(fs.stat(path.join(workspace, 'public')), { code: 'ENOENT' });
});

test('父目录junction或符号链接不能逃逸到工作区外', async t => {
  const { workspace, parent } = await setup(t);
  const outside = path.join(parent, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'secret.js'), 'outside');
  await fs.symlink(outside, path.join(workspace, 'src'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(readProjectFiles(workspace), /链接/u);
  await assert.rejects(applyProjectFiles({ workspace, files: [file('public/a.js'), file('src/secret.js', 'override')] }), /链接/u);
  assert.equal(await fs.readFile(path.join(outside, 'secret.js'), 'utf8'), 'outside');
  assert.deepEqual(await fs.readdir(workspace), ['src']);
  await assert.rejects(readProjectFiles(path.join(workspace, 'src')), /链接/u);
});

test('文件硬链接不能读写，其他文件保持不变', async t => {
  const { workspace, parent } = await setup(t);
  const outside = path.join(parent, 'original.js');
  await fs.writeFile(outside, 'outside');
  await fs.mkdir(path.join(workspace, 'src'));
  await fs.link(outside, path.join(workspace, 'src/app.mjs'));
  await assert.rejects(readProjectFiles(workspace), /硬链接/u);
  await assert.rejects(applyProjectFiles({ workspace, files: [file('public/a.js'), file('src/app.mjs', 'override')] }), /硬链接/u);
  assert.equal(await fs.readFile(outside, 'utf8'), 'outside');
  await assert.rejects(fs.stat(path.join(workspace, 'public')), { code: 'ENOENT' });
});

test('读取拒绝超限或非法UTF-8的允许源码', async t => {
  const { workspace } = await setup(t);
  await fs.mkdir(path.join(workspace, 'src'));
  const target = path.join(workspace, 'src/a.txt');
  await fs.writeFile(target, Buffer.alloc(128 * 1024 + 1, 97));
  await assert.rejects(readProjectFiles(workspace), /128 KiB/u);
  await fs.writeFile(target, Buffer.from([0xc3, 0x28]));
  await assert.rejects(readProjectFiles(workspace), /UTF-8/u);
});

test('写入中途失败回滚已替换文件并清理本批临时文件', async t => {
  const { workspace } = await setup(t);
  const initial = [file('src/a.js', 'original A'), file('src/b.js', 'original B')];
  await applyProjectFiles({ workspace, files: initial });
  const originalRename = fs.rename.bind(fs);
  let calls = 0;
  const mock = t.mock.method(fs, 'rename', async (...args) => {
    calls++;
    if (calls === 3) throw new Error('模拟第三次rename失败');
    return originalRename(...args);
  });
  await assert.rejects(applyProjectFiles({ workspace, files: [file('src/a.js', 'new A'), file('src/b.js', 'new B'), file('docs/new.md', 'new document')] }), /回滚/u);
  mock.mock.restore();
  assert.deepEqual(await readProjectFiles(workspace), validateProjectFiles(initial));
  assert.deepEqual((await fs.readdir(path.join(workspace, 'src'))).sort(), ['a.js', 'b.js']);
  await assert.rejects(fs.stat(path.join(workspace, 'docs')), { code: 'ENOENT' });
});

test('并发批次串行合并且保留未声明文件，完整源码仍受总限制', async t => {
  const { workspace } = await setup(t);
  await Promise.all([applyProjectFiles({ workspace, files: [file('src/a.js')] }), applyProjectFiles({ workspace, files: [file('src/b.js')] })]);
  assert.equal((await readProjectFiles(workspace)).length, 2);
  const large = Array.from({ length: 16 }, (_, index) => file(`docs/${index}.txt`, 'x'.repeat(128 * 1024)));
  await assert.rejects(applyProjectFiles({ workspace, files: large }), /2 MiB/u);
  assert.equal((await readProjectFiles(workspace)).length, 2);
  await assert.rejects(fs.stat(path.join(workspace, 'docs')), { code: 'ENOENT' });
});

test('工作区必须已存在且不是根目录或相对目录', async t => {
  const { workspace } = await setup(t);
  for (const candidate of ['.', path.parse(workspace).root, path.join(workspace, 'missing')]) await assert.rejects(readProjectFiles(candidate));
});

test('回滚发现其他操作改写过的文件时保留未知数据并明确报告', async t => {
  const { workspace } = await setup(t);
  await applyProjectFiles({ workspace, files: [file('src/a.js', 'original A'), file('src/b.js', 'original B')] });
  const originalRename = fs.rename.bind(fs);
  let calls = 0;
  const mock = t.mock.method(fs, 'rename', async (...args) => {
    if (++calls === 2) {
      await fs.writeFile(path.join(workspace, 'src/a.js'), 'other writer data');
      throw new Error('模拟后继提交失败');
    }
    return originalRename(...args);
  });
  await assert.rejects(applyProjectFiles({ workspace, files: [file('src/a.js', 'new A'), file('src/b.js', 'new B')] }), /保留未知数据/u);
  mock.mock.restore();
  assert.equal(await fs.readFile(path.join(workspace, 'src/a.js'), 'utf8'), 'other writer data');
  assert.equal(await fs.readFile(path.join(workspace, 'src/b.js'), 'utf8'), 'original B');
  assert.deepEqual((await fs.readdir(path.join(workspace, 'src'))).sort(), ['a.js', 'b.js']);
});

test('允许文件路径上的junction也不能作为普通源码读写', async t => {
  const { workspace, parent } = await setup(t);
  const outside = path.join(parent, 'outside');
  await fs.mkdir(outside);
  await fs.mkdir(path.join(workspace, 'src'));
  await fs.symlink(outside, path.join(workspace, 'src/app.mjs'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(readProjectFiles(workspace), /链接/u);
  await assert.rejects(applyProjectFiles({ workspace, files: [file('src/app.mjs')] }), /链接/u);
  assert.deepEqual(await fs.readdir(outside), []);
});
