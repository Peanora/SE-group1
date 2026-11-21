import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { installWebShell } from '../../lib/web-delivery.mjs';
import { applyProjectFiles } from '../../lib/project-files.mjs';
import { inspectPlannedSource } from '../../lib/planned-source.mjs';
import { minimalEnv } from '../../lib/managed-process.mjs';
import { hash, sourceHash } from './planned-evolution-fixture.mjs';

// The authorization dependency is deliberately a test fixture. This creates
// actual Git/receipt provenance and makes no claim of independent acceptance.
export async function createLocalCandidate(f, ordinal) {
  const directory = path.join(f.sourceRootDir, `planned-web-local-${ordinal}`), workspace = path.join(directory, 'workspace'); await mkdir(workspace, { recursive: true }); const shell = await installWebShell({ workspace }); await mkdir(path.join(workspace, '.platform')); await writeFile(path.join(workspace, '.platform/gitconfig'), '');
  const git = args => execFileSync('git', ['-c', 'core.hooksPath=.platform/no-hooks', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', '-c', 'user.name=Local pair fixture', '-c', 'user.email=fixture@localhost', ...args], { cwd: workspace, encoding: 'utf8', windowsHide: true, env: { ...minimalEnv({ PATH: process.env.PATH || '' }), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(workspace, '.platform/gitconfig') } }).trim();
  git(['init', '--quiet']); git(['add', '--', '.']); git(['commit', '--quiet', '-m', 'protected base']); const baseCommit = git(['rev-parse', 'HEAD']);
  const files = f.files.map(file => file.path === 'src/app.mjs' ? { path: file.path, content: file.content.replace('SELECT id,owner,value FROM', 'SELECT id,owner,value,priority FROM') + `// paired source ${ordinal}\n` } : file); await applyProjectFiles({ workspace, files }); git(['add', '--', ...files.map(file => file.path)]); git(['commit', '--quiet', '-m', `candidate ${ordinal}`]); const candidateCommit = git(['rev-parse', 'HEAD']);
  const originBinding = { ...f.originBinding, runId: `new-local-${ordinal}`, executionId: `new-execution-${ordinal}`, candidateCommit, sourceHash: sourceHash(files), sourceRevision: String(ordinal).repeat(64), sourceGeneration: ordinal, specRevision: 'd'.repeat(64), planRevision: 'e'.repeat(64) };
  const identity = { id: originBinding.executionId, ...Object.fromEntries(['projectId', 'runId', 'specRevision', 'planRevision'].map(key => [key, originBinding[key]])), taskId: 'whole', attemptId: randomUUID(), manifestHash: 'f'.repeat(64) }, modelCalls = [];
  for (const role of ['coding', 'review']) { const receiptPath = path.join(directory, `model-${role}-1.json`), raw = JSON.stringify({ model: `fixture-${role}`, finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 }, content: JSON.stringify(role === 'coding' ? { files } : { summary: 'fixture', issues: [], resolutions: [] }) }); await writeFile(receiptPath, raw); modelCalls.push({ id: randomUUID(), role, kind: 'model', attempt: 1, ...Object.fromEntries(['projectId', 'runId', 'specRevision', 'planRevision', 'taskId', 'attemptId', 'manifestHash'].map(key => [key, identity[key]])), candidateCommit: role === 'review' ? candidateCommit : null, inputSourceHash: role === 'review' ? sourceHash(files) : sourceHash([]), usage: { inputTokens: 1, outputTokens: 1 }, model: `fixture-${role}`, finishReason: 'stop', receiptConfirmed: true, receiptPath, receiptHash: hash(raw) }); }
  const reportPath = path.join(directory, 'execution.json'), record = { ...identity, profileId: 'planned-web-v1', providerKind: 'model', reviewerKind: 'model', status: 'failed', terminationConfirmed: true, workspace, baseCommit, candidateCommit, shellHash: shell.hash, modelCalls, totalModelCalls: 2, versions: [{ attempt: 1, commit: candidateCommit, sourceHash: sourceHash(files), selfCheck: { status: 'failed', checks: [] }, acceptance: null }] }; await writeFile(reportPath, JSON.stringify(record));
  const sourceHandle = await inspectPlannedSource({ rootDir: f.sourceRootDir, reportPath, binding: originBinding, writablePaths: files.map(file => file.path) }); return { originBinding, files, sourceHandle, sourceRootDir: f.sourceRootDir, sourceHash: originBinding.sourceHash, shellHash: shell.hash, assertCurrent: () => true };
}
