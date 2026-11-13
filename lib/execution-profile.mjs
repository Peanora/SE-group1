import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');

// This first profile is platform-owned. Candidate code cannot edit the contract or verdict.
export const borrowingProfile = Object.freeze({
  id: 'library-borrow-v1',
  writableFile: 'src/borrow.mjs',
  task: `实现 src/borrow.mjs 的同步纯函数命名导出 borrowBook(state, userId)。
state 为非 null、非数组对象 { stock: 非负整数, loans: 字符串数组 }。loans 数组可以为空；每个元素必须为 trim() 后长度大于0的字符串。userId 也必须为 trim() 后长度大于0的字符串，保留传入字符串的原值。
非法参数抛出 Error('INVALID_INPUT')；已借阅的用户抛出 Error('ALREADY_BORROWED')；库存为0抛出 Error('OUT_OF_STOCK')。按上述顺序校验。
成功返回新的 { stock: state.stock - 1, loans: [...state.loans, userId] }。
所有分支不得修改传入对象及数组。不使用外部依赖、文件、进程或网络。仅修改指定文件。`,
  seed: "export function borrowBook(state, userId) {\n  throw new Error('NOT_IMPLEMENTED');\n}\n",
});

export const validationCases = [
  { name: '正常借阅且保留原对象', state: { stock: 2, loans: ['alice'] }, userId: 'bob', expected: { value: { stock: 1, loans: ['alice', 'bob'] }, unchanged: true } },
  { name: '最后一本书', state: { stock: 1, loans: [] }, userId: 'alice', expected: { value: { stock: 0, loans: ['alice'] }, unchanged: true } },
  { name: '库存不足', state: { stock: 0, loans: [] }, userId: 'alice', expected: { error: 'OUT_OF_STOCK', unchanged: true } },
  { name: '重复借阅优先于库存判断', state: { stock: 0, loans: ['alice'] }, userId: 'alice', expected: { error: 'ALREADY_BORROWED', unchanged: true } },
  { name: '负库存', state: { stock: -1, loans: [] }, userId: 'alice', expected: { error: 'INVALID_INPUT', unchanged: true } },
  { name: '非整数库存', state: { stock: 1.5, loans: [] }, userId: 'alice', expected: { error: 'INVALID_INPUT', unchanged: true } },
  { name: '空用户', state: { stock: 1, loans: [] }, userId: '', expected: { error: 'INVALID_INPUT', unchanged: true } },
  { name: '非法借阅记录', state: { stock: 1, loans: [''] }, userId: 'alice', expected: { error: 'INVALID_INPUT', unchanged: true } },
  { name: '缺失状态', state: null, userId: 'alice', expected: { error: 'INVALID_INPUT', unchanged: true } },
  { name: '空白用户', state: { stock: 1, loans: [] }, userId: '  ', expected: { error: 'INVALID_INPUT', unchanged: true } },
  { name: '空白借阅记录', state: { stock: 1, loans: ['  '] }, userId: 'alice', expected: { error: 'INVALID_INPUT', unchanged: true } },
  { name: '非字符串借阅记录', state: { stock: 1, loans: [123] }, userId: 'alice', expected: { error: 'INVALID_INPUT', unchanged: true } },
  { name: '后续用户竞争耗尽库存', sequence: [{ stock: 1, loans: [] }, 'alice', 'bob'], expected: { value: { first: { stock: 0, loans: ['alice'] }, secondError: 'OUT_OF_STOCK' }, unchanged: true } },
];

export const runnerSource = readFileSync(new URL('./execution-runner.cjs', import.meta.url), 'utf8');
export const validationManifest = Object.freeze({ version: 'library-borrow-checks-v2', casesHash: hash(validationCases),
  runnerHash: hash(runnerSource), hash: hash({ cases: validationCases, runnerSource }), count: validationCases.length });
