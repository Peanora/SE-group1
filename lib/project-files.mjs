import fs from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';

const ROOTS = new Set(['src', 'public', 'migrations', 'tests', 'docs']);
const EXTENSIONS = new Set(['.mjs', '.js', '.cjs', '.html', '.css', '.json', '.sql', '.md', '.txt', '.svg']);
const RESERVED = new Set(['.git', '.platform', 'node_modules']);
const MAX_FILE_BYTES = 128 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 60;
const workspaceQueues = new Map();
const fail = message => { throw new Error(message); };
const fold = value => value.normalize('NFC').toUpperCase().toLowerCase().normalize('NFC');
const isMissing = error => error?.code === 'ENOENT';
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
const sameVersion = (a, b) => sameFile(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

function segments(relative) {
  if (typeof relative !== 'string' || !relative || !relative.isWellFormed() || relative.length > 1024 || relative !== relative.normalize('NFC') || /[\\%\x00-\x1f\x7f<>:"|?*]/u.test(relative)) fail('文件路径必须是不含编码或特殊字符的相对 POSIX 路径。');
  const parts = relative.split('/');
  if (parts.length > 32 || parts.some(part => !part || part === '.' || part === '..' || part.length > 255 || part !== part.trim() || /[. ]$/u.test(part) || RESERVED.has(fold(part)) || /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(part))) fail('文件路径包含空段、保留名称或不安全目录。');
  return parts;
}

function allowedPath(relative) {
  const parts = segments(relative);
  if (relative !== 'README.md' && (parts.length < 2 || !ROOTS.has(parts[0]))) fail('文件只能位于 src、public、migrations、tests、docs 或根 README.md。');
  if (!EXTENSIONS.has(path.posix.extname(relative))) fail('文件扩展名不在允许的纯文本类型中。');
  return relative;
}

function validateContent(content) {
  if (typeof content !== 'string' || !content.isWellFormed() || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(content)) fail('文件内容必须是有效 UTF-8 纯文本。');
  if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) fail('单个文件不得超过 128 KiB。');
  return content;
}

/** Complete replacements only; no command, delete or permission fields are accepted. */
export function validateProjectFiles(files) {
  if (!Array.isArray(files) || files.length > MAX_FILES) fail('文件建议必须是最多 60 个文件的数组。');
  const keys = new Set();
  let total = 0;
  const normalized = files.map(file => {
    if (!file || typeof file !== 'object' || Array.isArray(file)) fail('每项文件建议必须包含 path 和 content。');
    const relative = allowedPath(file.path);
    const key = fold(relative);
    if (keys.has(key)) fail('文件建议包含大小写重复路径。');
    keys.add(key);
    const content = validateContent(file.content);
    total += Buffer.byteLength(content, 'utf8');
    if (total > MAX_TOTAL_BYTES) fail('全部项目源码不得超过 2 MiB。');
    return { path: relative, content };
  });
  for (const key of keys) {
    const parts = key.split('/');
    for (let index = 1; index < parts.length; index++) if (keys.has(parts.slice(0, index).join('/'))) fail('文件建议中的文件与父目录冲突。');
  }
  return normalized.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

async function statOrNull(target) {
  try { return await fs.lstat(target, { bigint: true }); } catch (error) { if (isMissing(error)) return null; throw error; }
}

function ordinary(stat, directory = false) {
  if (!stat || stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) || (!directory && stat.nlink !== 1n)) fail('工作区包含链接、硬链接或非普通文件，已拒绝访问。');
}

async function workspaceRoot(workspace) {
  if (typeof workspace !== 'string' || !path.isAbsolute(workspace)) fail('请提供已存在的可信工作区绝对路径。');
  const root = path.resolve(workspace);
  const anchor = path.parse(root).root;
  if (root === anchor) fail('文件系统根目录不能作为项目工作区。');
  let current = anchor;
  ordinary(await statOrNull(current), true);
  for (const part of root.slice(anchor.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    ordinary(await statOrNull(current), true);
  }
  const resolved = await fs.realpath(root);
  if (fold(resolved) !== fold(root)) fail('工作区路径解析越界。');
  return { root, stat: await fs.lstat(root, { bigint: true }) };
}

async function assertRoot(context) {
  const checked = await workspaceRoot(context.root);
  if (!sameFile(context.stat, checked.stat)) fail('工作区已被替换，请重新建立可信工作区。');
}

function targetPath(context, relative) {
  const target = path.resolve(context.root, ...relative.split('/'));
  const fromRoot = path.relative(context.root, target);
  if (!fromRoot || fromRoot.startsWith(`..${path.sep}`) || fromRoot === '..' || path.isAbsolute(fromRoot)) fail('文件路径越过工作区边界。');
  return target;
}

async function matchingChild(parent, name) {
  const names = await fs.readdir(parent);
  if (names.some(existing => fold(existing) === fold(name) && existing !== name)) fail('工作区存在大小写或 Unicode 冲突路径。');
}

async function inspectTarget(context, relative) {
  await assertRoot(context);
  const parts = relative.split('/');
  let parent = context.root;
  for (const [index, part] of parts.entries()) {
    await matchingChild(parent, part);
    const target = path.join(parent, part);
    const stat = await statOrNull(target);
    if (!stat) return null;
    if (index === parts.length - 1) { ordinary(stat); return stat; }
    ordinary(stat, true);
    parent = target;
  }
}

async function readText(context, relative, expected) {
  const target = targetPath(context, relative);
  const before = await inspectTarget(context, relative);
  if (!before || (expected && !sameVersion(expected, before))) fail('文件在读取前发生变化，已停止访问。');
  if (before.size > MAX_FILE_BYTES) fail('单个文件不得超过 128 KiB。');
  const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    ordinary(opened);
    if (!sameVersion(before, opened)) fail('文件在打开时发生变化，已停止访问。');
    const chunks = [];
    let size = 0;
    for (;;) {
      const chunk = Buffer.alloc(16 * 1024);
      const { bytesRead } = await handle.read(chunk);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > MAX_FILE_BYTES) fail('单个文件不得超过 128 KiB。');
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const after = await inspectTarget(context, relative);
    if (!after || !sameVersion(before, after) || !sameVersion(before, await handle.stat({ bigint: true }))) fail('文件在读取期间发生变化，已停止访问。');
    let content;
    try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks)); } catch { fail('工作区文件不是有效 UTF-8 纯文本。'); }
    return { content: validateContent(content), stat: after };
  } finally { await handle.close(); }
}

async function collectFiles(context) {
  await assertRoot(context);
  const files = [];
  let visited = 0;
  let total = 0;
  async function walk(relative) {
    const directory = relative ? targetPath(context, relative) : context.root;
    ordinary(await fs.lstat(directory, { bigint: true }), true);
    for (const name of (await fs.readdir(directory)).sort()) {
      if (++visited > 4096) fail('工作区目录项过多，已停止读取。');
      if (RESERVED.has(fold(name))) continue;
      const child = relative ? `${relative}/${name}` : name;
      if (!relative && !ROOTS.has(name) && name !== 'README.md') {
        if (ROOTS.has(fold(name)) || fold(name) === 'readme.md') fail('工作区存在非规范大小写路径。');
        continue;
      }
      const target = targetPath(context, child);
      const stat = await fs.lstat(target, { bigint: true });
      if (stat.isSymbolicLink()) fail('工作区包含链接，已拒绝读取。');
      if (!relative && ROOTS.has(name) && !stat.isDirectory()) fail('源码根路径必须是普通目录。');
      if (stat.isDirectory()) {
        segments(child);
        // README.md is a file, never an additional readable tree.
        if (child === 'README.md') fail('README.md 不能是目录。');
        await inspectTarget(context, `${child}/.project-inspection.tmp`);
        await walk(child);
      } else {
        if (!EXTENSIONS.has(path.posix.extname(child))) continue;
        allowedPath(child);
        const { content } = await readText(context, child, stat);
        files.push({ path: child, content });
        total += Buffer.byteLength(content, 'utf8');
        if (total > MAX_TOTAL_BYTES) fail('全部项目源码不得超过 2 MiB。');
        if (files.length > MAX_FILES) fail('项目源码文件数超过 60。');
      }
    }
  }
  await walk('');
  return validateProjectFiles(files);
}

async function locked(workspace, work) {
  const key = typeof workspace === 'string' ? fold(path.resolve(workspace)) : '';
  const previous = workspaceQueues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(work);
  workspaceQueues.set(key, next);
  try { return await next; } finally { if (workspaceQueues.get(key) === next) workspaceQueues.delete(key); }
}

/** Reads only proposal-owned text; platform files, Git, dependencies and databases are excluded. */
export async function readProjectFiles(workspace) {
  return locked(workspace, async () => collectFiles(await workspaceRoot(workspace)));
}

async function ensureParents(context, relative, created) {
  let parent = context.root;
  const parts = relative.split('/').slice(0, -1);
  for (const part of parts) {
    await assertRoot(context);
    await matchingChild(parent, part);
    const target = path.join(parent, part);
    let stat = await statOrNull(target);
    if (!stat) {
      await fs.mkdir(target, { mode: 0o700 });
      stat = await fs.lstat(target, { bigint: true });
      created.push({ target, stat, relative: path.relative(context.root, target).split(path.sep).join('/') });
    }
    ordinary(stat, true);
    parent = target;
  }
}

async function temporary(context, relative, content) {
  await inspectTarget(context, relative);
  const target = path.join(path.dirname(targetPath(context, relative)), `.project-write-${randomUUID()}.tmp`);
  const handle = await fs.open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  const owned = { target, stat: await handle.stat({ bigint: true }) };
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    return { target, stat: await handle.stat({ bigint: true }) };
  } catch (error) {
    await handle.close();
    await inspectTarget(context, relative).then(() => removeOwned(owned)).catch(() => {});
    throw error;
  } finally { await handle.close(); }
}

async function removeOwned(entry) {
  const current = await statOrNull(entry.target);
  if (current && sameFile(entry.stat, current) && current.isFile() && !current.isSymbolicLink() && current.nlink === 1n) await fs.unlink(entry.target);
}

/** Caller owns an isolated, trusted workspace and must stop candidate processes before writing. */
export async function applyProjectFiles({ workspace, files } = {}) {
  const proposals = validateProjectFiles(files);
  return locked(workspace, async () => {
    const context = await workspaceRoot(workspace);
    const existing = await collectFiles(context);
    const merged = new Map(existing.map(file => [fold(file.path), file]));
    const changes = [];
    const unchanged = [];
    for (const file of proposals) {
      const oldStat = await inspectTarget(context, file.path);
      const prior = oldStat ? await readText(context, file.path, oldStat) : null;
      if (prior?.content === file.content) unchanged.push(file.path);
      else changes.push({ ...file, prior, staged: null, committed: false });
      merged.set(fold(file.path), file);
    }
    validateProjectFiles([...merged.values()]);
    const created = [];
    try {
      for (const item of changes) {
        await ensureParents(context, item.path, created);
        item.staged = await temporary(context, item.path, item.content);
      }
      for (const item of changes) {
        const current = await inspectTarget(context, item.path);
        if (item.prior ? !current || !sameVersion(item.prior.stat, current) : current) fail('写入前文件已变化，已停止本批修改。');
        await fs.rename(item.staged.target, targetPath(context, item.path));
        item.committed = true;
      }
      const finalFiles = await collectFiles(context);
      return { changed: changes.map(item => item.path), unchanged, sourceHash: createHash('sha256').update(JSON.stringify(finalFiles)).digest('hex') };
    } catch {
      let incomplete = false;
      for (const item of [...changes].reverse()) {
        if (!item.committed) continue;
        try {
          const current = await inspectTarget(context, item.path);
          if (!current || !sameFile(current, item.staged.stat)) { incomplete = true; continue; }
          const actual = await readText(context, item.path, current);
          if (actual.content !== item.content) { incomplete = true; continue; }
          if (item.prior) {
            const rollback = await temporary(context, item.path, item.prior.content);
            try { await fs.rename(rollback.target, targetPath(context, item.path)); } finally { await removeOwned(rollback); }
          } else await fs.unlink(targetPath(context, item.path));
        } catch { incomplete = true; }
      }
      fail(incomplete ? '批次写入失败；部分路径已被其他操作改变，已保留未知数据，请核对工作区。' : '批次写入失败，已回滚本批文件修改。');
    } finally {
      for (const item of changes) if (item.staged) {
        try { await inspectTarget(context, item.path); await removeOwned(item.staged); } catch { /* Unknown replacements must be preserved. */ }
      }
      for (const item of created.reverse()) {
        try {
          await inspectTarget(context, `${item.relative}/.project-inspection.tmp`);
          const current = await statOrNull(item.target);
          if (current && sameFile(current, item.stat) && current.isDirectory() && !current.isSymbolicLink()) await fs.rmdir(item.target);
        } catch { /* Keep populated or replaced directories. */ }
      }
    }
  });
}
