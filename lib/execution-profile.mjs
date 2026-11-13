import { createHash } from 'node:crypto';

export const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');

// This first profile is platform-owned. Candidate code cannot edit the contract or verdict.
export const borrowingProfile = Object.freeze({
  id: 'library-borrow-v1',
  writableFile: 'src/borrow.mjs',
  task: `实现 src/borrow.mjs 的命名导出 borrowBook(state, userId)。
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

export const validationManifest = Object.freeze({ version: 'library-borrow-checks-v1', hash: hash(validationCases), count: validationCases.length });

// Only observations cross this process boundary; assertions stay in the controlling process.
export const runnerSource = `const { pathToFileURL } = require('node:url');
(async () => {
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  const cases = JSON.parse(text);
  const { borrowBook } = await import(pathToFileURL(require('node:path').resolve('src/borrow.mjs')).href);
  const results = [];
  for (const item of cases) {
    const state = item.sequence ? item.sequence[0] : item.state;
    const before = JSON.stringify(state);
    let observation;
    try {
      if (item.sequence) {
        const first = await borrowBook(state, item.sequence[1]);
        let secondError = null;
        try { await borrowBook(first, item.sequence[2]); } catch (error) { secondError = String(error.message); }
        observation = { value: { first, secondError } };
      } else observation = { value: await borrowBook(state, item.userId) };
    } catch (error) { observation = { error: String(error.message) }; }
    results.push({ ...observation, unchanged: JSON.stringify(state) === before });
  }
  process.stdout.write(JSON.stringify(results));
})().catch(() => { process.stderr.write('候选模块无法加载或执行'); process.exitCode = 1; });
`;
