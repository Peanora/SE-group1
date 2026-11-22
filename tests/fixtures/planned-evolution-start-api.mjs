import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createPlannedEvolutionService } from '../../lib/planned-evolution.mjs';
import { createPlannedExecutionService } from '../../lib/planned-execution-service.mjs';

const [directory, fault] = process.argv.slice(2);
const { data, record, revision, evolutionId, identity } = JSON.parse(await readFile(path.join(directory, 'input.json'), 'utf8'));
const config = { baseUrl: 'http://127.0.0.1:1', model: 'synthetic-never-called', apiKey: 'never-sent-fixture-credential' };
let revokeWhileReserving = false, revoked = false;
let evolution;
const executionInput = { ...identity, proposalId: record.input.proposalId, revision: record.input.definitionRevision };
const verificationService = {
  list: async () => ({ proposals: [{ id: executionInput.proposalId, revision: executionInput.revision, current: true, approved: true, proposal: { browser: {} } }] }),
  withApprovedExecution() { assert.fail('the checkpoint is still blocked'); },
  assertFrozenExecution() { assert.fail('execution binding is not prepared'); },
  assertApprovedDefinition(value) { assert.deepEqual(value, executionInput); },
};
const getPlanningSync = () => data;
const execution = await createPlannedExecutionService({
  rootDir: path.join(directory, 'execution'),
  verificationService, getPlanningSync, config, executable: process.execPath,
  withCheckpoint: () => new Promise(() => {}),
  dependencies: {
    hasExternalActivity: projectId => !!evolution?.hasActivity(projectId),
    createProvider: async () => { await writeFile(path.join(directory, 'unexpected-model-call'), 'coding'); assert.fail('unexpected coding factory'); },
    createReviewer: async () => { await writeFile(path.join(directory, 'unexpected-model-call'), 'reviewing'); assert.fail('unexpected Review factory'); },
  },
});
if (fault === 'rollback-association') {
  const ledger = new DatabaseSync(path.join(directory, 'execution', 'planned.sqlite'));
  try {
    ledger.exec("CREATE TRIGGER forced_association_rollback BEFORE INSERT ON evolution_starts BEGIN SELECT RAISE(ABORT,'fixture transaction failure'); END;");
  } finally { ledger.close(); }
}
const rootDir = path.join(directory, 'evolutions');
evolution = await createPlannedEvolutionService({
  rootDir, sourceRootDir: directory, getPlanningSync, verificationService,
  plannedService: {
    ...execution,
    async startEvolution(...args) {
      if (fault === 'before-reservation') process.exit(41);
      if (fault === 'revoke-before-reservation' && !revoked) { revokeWhileReserving = true; revoked = true; }
      try {
        const started = await execution.startEvolution(...args);
        if (fault === 'after-reservation') process.exit(42);
        return started;
      } finally { revokeWhileReserving = false; }
    },
  },
  releaseService: { authorizeStoppedDataset: () => assert.fail('no release operation') },
  datasetService: { snapshot: () => assert.fail('no data operation') },
  withCheckpoint: (_project, work) => work(),
});
const db = new DatabaseSync(path.join(rootDir, 'evolutions.sqlite'));
try {
  const now = new Date().toISOString();
  db.prepare("INSERT OR IGNORE INTO evolutions VALUES(?,?,?,?,?,'approved',0,?,?,?,?)")
    .run(evolutionId, identity.projectId, identity.runId, 'request-1', 'fixture-input', revision, JSON.stringify(record), now, now);
} finally { db.close(); }
const contractRevision = (await execution.list(identity)).capabilities.contractRevision;
const server = http.createServer(async (request, response) => {
  const assertAccess = () => request.headers.authorization === 'Bearer fixture-owner' && !revokeWhileReserving;
  let status = 200, body;
  try {
    if (request.method === 'POST' && request.url === '/planned') {
      if (!assertAccess()) { response.writeHead(403).end(); return; }
      body = await execution.start({ ...executionInput, contractRevision });
      status = 202;
    } else if (request.method === 'POST' && request.url === '/checkpoint') {
      if (!assertAccess()) { response.writeHead(403).end(); return; }
      await execution.withProjectCheckpoint(identity.projectId, () => undefined);
      body = { checkpoint: true };
    } else if (request.method === 'POST') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const fields = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      body = await evolution.start({ ...identity, revision, contractRevision, ...fields }, { assertAccess });
      status = 202;
    } else {
      if (!assertAccess()) { response.writeHead(403).end(); return; }
      body = await evolution.list(identity);
    }
  } catch (error) {
    status = error.status ?? 500;
    body = { code: error.code ?? 'unexpected_error' };
  }
  response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
});
server.listen(0, '127.0.0.1', () => process.send({ port: server.address().port }));
process.on('message', async message => {
  if (message !== 'close') return;
  server.closeAllConnections();
  server.close();
  await evolution.shutdown();
  await execution.shutdown();
  process.disconnect();
});
