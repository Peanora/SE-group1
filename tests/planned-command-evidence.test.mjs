import test from 'node:test';
import assert from 'node:assert/strict';
import { plannedCommandEvidence } from '../lib/planned-command-evidence.mjs';

test('public command evidence excludes paths, output, process control and arbitrary command text', () => {
  const privateValue = 'private-platform-secret';
  const commands = plannedCommandEvidence({ taskId: 'one', gitCommands: [{ args: ['clone', `C:/${privateValue}`], stdout: privateValue, stderr: privateValue,
    pid: 12345, env: { secret: privateValue }, terminationConfirmed: true, exitCode: 0, durationMs: 12, startedAt: '2026-11-18T00:00:00.000Z' }] });
  assert.equal(commands[0].tool, 'git clone'); assert.equal(commands[0].status, 'completed'); assert.equal(commands[0].durationMs, 12);
  assert.equal(JSON.stringify(commands).includes(privateValue), false); assert.equal(Object.hasOwn(commands[0], 'pid'), false);
});
test('confirmed failure and unconfirmed stop do not inherit a successful command status', () => {
  const result = plannedCommandEvidence({ versions: [{ acceptance: { browser: { processes: [{ kind: 'runtime', status: 'failed', terminationConfirmed: true, exitCode: 0 },
    { kind: 'browser', status: 'stopped', terminationConfirmed: false, exitCode: 0 }] } } }] });
  assert.deepEqual(result.map(item => item.status), ['failed', 'unknown']); assert.equal(result[1].tool, 'browser');
});
test('all task attempts remain represented and summary is bounded', () => {
  const old = { gitCommands: [{ args: ['commit'], terminationConfirmed: true, exitCode: 1 }] }, current = { gitCommands: [{ args: ['status'], terminationConfirmed: true, exitCode: 0 }] };
  assert.deepEqual(plannedCommandEvidence({ profileId: 'planned-task-run-v1', tasks: [{ id: 'one', history: [old], record: current }] }).map(item => item.status), ['failed', 'completed']);
  assert.equal(plannedCommandEvidence({ gitCommands: Array(800).fill(current.gitCommands[0]) }).length, 500);
});
