'use strict';
// Platform-owned fixed MXC entry. Never loads candidate JS or executes supplied SQL.
const { DatabaseSync, backup } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const root = path.resolve('.platform/tmp'), input = path.join(root, 'input.sqlite'), output = path.join(root, 'output.sqlite');
const need = (value, code = 'invalid_database') => { if (!value) throw Object.assign(new Error(code), { code }); };
const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const q = name => { need(typeof name === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) && !/^sqlite_/i.test(name), 'unsupported_identifier'); return '"' + name + '"'; };
const plain = (raw, names) => { need(raw && Object.getPrototypeOf(raw) === Object.prototype && Object.keys(raw).length === names.length && names.every(key => Object.hasOwn(raw, key)), 'invalid_plan'); return raw; };
const scalar = value => { need(value === null || typeof value === 'string' && Buffer.byteLength(value) <= 4096 && !value.includes('\0') || Number.isSafeInteger(value), 'invalid_plan'); return value; };
const encode = value => value === null ? ['null'] : typeof value === 'bigint' ? ['integer', String(value)] : typeof value === 'number' ? ['real', String(value)] : typeof value === 'string' ? ['text', value] : value instanceof Uint8Array ? ['blob', Buffer.from(value).toString('base64')] : (() => { throw new Error('unsupported_value'); })();
const rowsHash = rows => hash(rows.map(row => JSON.stringify(Object.fromEntries(Object.keys(row).sort().map(key => [key, encode(row[key])])))).sort());
function open(filename, readOnly) { const db = new DatabaseSync(filename, { readOnly, enableLoadExtension: false }); db.exec('PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=3000; PRAGMA foreign_keys=ON;'); return db; }
function snapshot(db) {
  need(db.prepare('PRAGMA integrity_check').all().every(row => Object.values(row)[0] === 'ok'), 'integrity_failed'); need(db.prepare('PRAGMA foreign_key_check').all().length === 0, 'foreign_key_failed');
  const listed = db.prepare('PRAGMA table_list').all().filter(row => row.schema === 'main' && !row.name.startsWith('sqlite_'));
  need(listed.length <= 32 && listed.every(row => row.type === 'table'), 'unsupported_schema');
  const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  need(schema.every(row => ['table', 'index'].includes(row.type)), 'unsupported_schema');
  let count = 0, valueBytes = 0; const tables = {};
  for (const row of listed.sort((a, b) => a.name.localeCompare(b.name))) {
    q(row.name); const columns = db.prepare(`PRAGMA table_xinfo(${q(row.name)})`).all(); need(columns.length > 0 && columns.length <= 64 && columns.every(col => col.hidden === 0), 'unsupported_columns'); columns.forEach(col => q(col.name));
    const statement = db.prepare(`SELECT * FROM ${q(row.name)} LIMIT 10001`); statement.setReadBigInts(true); const rows = statement.all(); count += rows.length; need(count <= 10000, 'row_limit');
    for (const item of rows) for (const value of Object.values(item)) { valueBytes += typeof value === 'string' ? Buffer.byteLength(value) : value instanceof Uint8Array ? value.byteLength : 16; need(valueBytes <= 32 * 1024 * 1024, 'data_limit'); }
    tables[row.name] = { columns, rows };
  }
  return { schemaHash: hash({ schema, userVersion: db.prepare('PRAGMA user_version').get().user_version }), rowsHash: hash(Object.entries(tables).map(([name, data]) => ({ name, count: data.rows.length, rowsHash: rowsHash(data.rows) }))), tables };
}
function publicSnapshot(value) { return { schemaHash: value.schemaHash, rowsHash: value.rowsHash, tables: Object.entries(value.tables).map(([name, data]) => ({ name, rows: data.rows.length, columns: data.columns.map(col => ({ name: col.name, type: col.type, pk: col.pk })), rowsHash: rowsHash(data.rows) })), integrity: 'ok' }; }
function normalize(raw) {
  plain(raw, ['version', 'kind', 'operations']); need(raw.version === 1 && ['none', 'bounded_operations'].includes(raw.kind) && Array.isArray(raw.operations) && raw.operations.length <= 16, 'invalid_plan');
  need(raw.kind === 'none' ? raw.operations.length === 0 : raw.operations.length > 0, 'invalid_plan'); const used = new Set();
  for (const op of raw.operations) {
    if (op.op === 'addColumn') { plain(op, ['op', 'table', 'column', 'type', 'nullable', 'default']); need(['TEXT', 'INTEGER'].includes(op.type) && typeof op.nullable === 'boolean', 'invalid_plan'); scalar(op.default); need(op.default !== null || op.nullable, 'invalid_plan'); need(op.default === null || (op.type === 'TEXT' ? typeof op.default === 'string' : Number.isSafeInteger(op.default)), 'invalid_plan'); }
    else { plain(op, ['op', 'table', 'column', 'mapping', 'unmapped']); need(op.op === 'mapValues' && op.unmapped === 'reject' && Array.isArray(op.mapping) && op.mapping.length > 0 && op.mapping.length <= 32, 'invalid_plan'); const values = new Set(); for (const item of op.mapping) { plain(item, ['from', 'to']); scalar(item.from); scalar(item.to); const key = JSON.stringify([typeof item.from, item.from]); need(!values.has(key), 'invalid_plan'); values.add(key); } }
    q(op.table); q(op.column); const key = `${op.table}:${op.column}`; need(!used.has(key), 'invalid_plan'); used.add(key);
  }
  return raw;
}
function apply(db, before, plan) {
  const expected = Object.fromEntries(Object.entries(before.tables).map(([name, data]) => [name, data.rows.map(row => ({ ...row }))]));
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const op of plan.operations) {
      const table = before.tables[op.table]; need(table, 'unknown_table');
      if (op.op === 'addColumn') {
        need(!table.columns.some(col => col.name.toLowerCase() === op.column.toLowerCase()), 'column_exists');
        const literal = op.default === null ? 'NULL' : op.type === 'INTEGER' ? String(op.default) : "'" + op.default.replaceAll("'", "''") + "'";
        db.exec(`ALTER TABLE ${q(op.table)} ADD COLUMN ${q(op.column)} ${op.type}${op.nullable ? '' : ' NOT NULL'} DEFAULT ${literal}`);
        for (const row of expected[op.table]) row[op.column] = op.default !== null && op.type === 'INTEGER' ? BigInt(op.default) : op.default;
      } else {
        const column = table.columns.find(col => col.name === op.column); need(column && column.pk === 0 && ['TEXT', 'INTEGER'].includes(column.type.toUpperCase()), 'unsupported_mapping_column');
        const value = raw => { need(raw === null || (column.type.toUpperCase() === 'TEXT' ? typeof raw === 'string' : Number.isSafeInteger(raw)), 'mapping_type'); return raw !== null && column.type.toUpperCase() === 'INTEGER' ? BigInt(raw) : raw; };
        const mapping = new Map(op.mapping.map(item => [JSON.stringify(encode(value(item.from))), value(item.to)]));
        for (const row of expected[op.table]) { const key = JSON.stringify(encode(row[op.column])); need(mapping.has(key), 'unmapped_value'); row[op.column] = mapping.get(key); }
        // A CASE applies the complete mapping once; chained mappings cannot update a row twice.
        const clauses = op.mapping.map(() => `WHEN ${q(op.column)} IS ? THEN ?`).join(' '), parameters = op.mapping.flatMap(item => [value(item.from), value(item.to)]);
        db.prepare(`UPDATE ${q(op.table)} SET ${q(op.column)}=CASE ${clauses} ELSE ${q(op.column)} END`).run(...parameters);
      }
    }
    const after = snapshot(db); need(Object.keys(after.tables).length === Object.keys(expected).length, 'row_invariant_failed');
    for (const [name, rows] of Object.entries(expected)) need(after.tables[name] && rowsHash(after.tables[name].rows) === rowsHash(rows), 'row_invariant_failed');
    db.exec('COMMIT'); return after;
  } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
}
async function main() {
  let text = ''; for await (const chunk of process.stdin) { text += chunk; need(Buffer.byteLength(text) <= 131072, 'input_limit'); }
  const job = plain(JSON.parse(text), ['version', 'nonce', 'operation', 'inputHash', 'inputSchemaHash', 'plan']); need(job.version === 1 && /^[A-Za-z0-9_-]{1,128}$/.test(job.nonce) && ['backup', 'migrate'].includes(job.operation), 'invalid_job');
  const stat = fs.lstatSync(input); need(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= 32 * 1024 * 1024); need(hash(fs.readFileSync(input)) === job.inputHash, 'input_changed'); need(!fs.existsSync(output), 'output_exists');
  const plan = normalize(job.plan); let source, target;
  try {
    source = open(input, true); const before = snapshot(source); if (job.inputSchemaHash !== null) need(before.schemaHash === job.inputSchemaHash, 'schema_changed');
    await backup(source, output); source.close(); source = null;
    target = open(output, false); const copied = snapshot(target); need(copied.schemaHash === before.schemaHash && copied.rowsHash === before.rowsHash, 'backup_mismatch');
    const after = job.operation === 'migrate' ? apply(target, copied, plan) : copied; target.close(); target = null;
    console.log(JSON.stringify({ version: 1, nonce: job.nonce, operation: job.operation, status: 'passed', inputHash: job.inputHash, before: publicSnapshot(before), after: publicSnapshot(after), outputHash: hash(fs.readFileSync(output)), outputBytes: fs.statSync(output).size, operationsHash: hash(plan) }));
  } finally { if (source) source.close(); if (target) target.close(); }
}
main().catch(error => { console.log(JSON.stringify({ version: 1, status: 'failed', code: /^[a-z_]{1,64}$/.test(error.code || '') ? error.code : 'worker_failed' })); process.exitCode = 1; });
