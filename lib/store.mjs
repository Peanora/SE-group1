import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { HttpError } from './documents.mjs';
import { contentRevision } from './planning-review.mjs';

function sourceVersion(project) {
  const revision = contentRevision(project.source);
  if (project.currentSourceRevision === undefined && project.sourceGeneration === undefined && project.sourceVersions === undefined && project.appliedChangeId === undefined) return { revision, generation: 0 };
  if (project.currentSourceRevision !== revision || !Number.isSafeInteger(project.sourceGeneration) || project.sourceGeneration < 0 || !Array.isArray(project.sourceVersions) || !project.sourceVersions.length || project.sourceVersions.length > 20 || project.sourceVersions.at(-1)?.revision !== revision || project.sourceVersions.at(-1)?.generation !== project.sourceGeneration) throw new HttpError(409, '项目输入版本记录不一致，请保留现场并核对。');
  return { revision, generation: project.sourceGeneration };
}

export class ProjectStore {
  constructor(directory) { this.directory = path.resolve(directory); this.projects = new Map(); this.queues = new Map(); this.persisted = new Map(); }

  async init() {
    await mkdir(this.directory, { recursive: true });
    for (const file of await readdir(this.directory)) {
      if (!/^[0-9a-f-]{36}\.json$/u.test(file)) continue;
      const project = JSON.parse(await readFile(path.join(this.directory, file), 'utf8'));
      if (!project.id || `${project.id}.json` !== file || !Array.isArray(project.runs)) throw new Error(`项目存档格式无效：${file}`);
      this.projects.set(project.id, project);
      this.persisted.set(project.id, structuredClone(project));
    }
    return this;
  }

  list() {
    return [...this.projects.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(p => ({
      id: p.id, name: p.name, createdAt: p.createdAt, updatedAt: p.updatedAt, filename: p.source.filename,
      lastRunStatus: p.runs.at(-1)?.status ?? null, runCount: p.runs.length,
    }));
  }

  get(id) {
    const project = this.projects.get(id);
    if (!project) throw new HttpError(404, '未找到该项目。');
    return project;
  }

  getRun(projectId, runId) {
    const project = this.get(projectId);
    const run = project.runs.find(item => item.id === runId);
    if (!run) throw new HttpError(404, '未找到该运行。');
    return { project, run };
  }

  /** Execution admission reads only the last successful file publication. */
  getPersistedRun(projectId, runId) {
    this.get(projectId);
    const project = this.persisted.get(projectId);
    const run = project?.runs.find(item => item.id === runId);
    if (!project || !run) throw new HttpError(409, '该规划尚未保存完成，请稍后重试。');
    return structuredClone({ project, run });
  }

  getSourceVersion(projectId) {
    const project = this.get(projectId), published = this.persisted.get(projectId);
    const current = sourceVersion(project);
    if (!published || JSON.stringify(sourceVersion(published)) !== JSON.stringify(current)) throw new HttpError(409, '项目输入尚未保存完成。');
    return { ...current, source: structuredClone(project.source) };
  }

  getPersistedProject(projectId) {
    this.get(projectId);
    const project = this.persisted.get(projectId);
    if (!project) throw new HttpError(409, '项目尚未保存完成。');
    return structuredClone(project);
  }

  async create({ name, source }) {
    const now = new Date().toISOString();
    const project = { id: randomUUID(), name, source, createdAt: now, updatedAt: now, runs: [] };
    this.projects.set(project.id, project);
    await this.save(project);
    return project;
  }

  save(project) { return this.#enqueue(project); }

  async #enqueue(project, publication = null) {
    project.updatedAt = new Date().toISOString();
    const contents = JSON.stringify(project, null, 2), snapshot = JSON.parse(contents), projectId = project.id;
    const previous = this.queues.get(projectId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      const published = this.persisted.get(projectId), live = this.projects.get(projectId);
      if (publication) {
        for (const existing of [published, live]) if (!existing || sourceVersion(existing).revision !== publication.baseRevision || sourceVersion(existing).generation !== publication.generation) throw new HttpError(409, '项目输入版本已变化，旧发布不能覆盖当前版本。');
      } else {
        for (const existing of [published, live]) if (existing?.currentSourceRevision !== undefined) {
          const current = sourceVersion(existing), incoming = sourceVersion(snapshot);
          if (incoming.revision !== current.revision || incoming.generation !== current.generation) throw new HttpError(409, '旧项目存档不能覆盖新的输入版本。');
        }
      }
      const target = path.join(this.directory, `${projectId}.json`);
      const temporary = `${target}.${randomUUID()}.tmp`;
      await writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, target);
      this.persisted.set(projectId, snapshot);
    });
    this.queues.set(projectId, next);
    try { await next; } finally { if (this.queues.get(projectId) === next) this.queues.delete(projectId); }
  }

  /** Trusted checkpoint-only publication: write a complete clone before changing live identities. */
  async publishSourceChange(projectId, { baseRevision, generation, changeId, source, impact, changeHash, policyHash }) {
    const project = this.get(projectId), current = this.getSourceVersion(projectId);
    if (current.revision !== baseRevision || current.generation !== generation || typeof changeId !== 'string' || !/^[0-9a-f-]{36}$/u.test(changeId)) throw new HttpError(409, '输入变更版本已失效。');
    const snapshot = structuredClone(project), now = new Date().toISOString();
    const versions = snapshot.sourceVersions ?? [{ generation: 0, revision: current.revision, source: structuredClone(snapshot.source), at: snapshot.createdAt, changeId: null, impact: null }];
    if (versions.length >= 20) throw new HttpError(409, '输入版本已达到20版上限。');
    const revision = contentRevision(source);
    if (revision === current.revision) throw new HttpError(409, '输入内容未变化。');
    snapshot.source = structuredClone(source); snapshot.currentSourceRevision = revision; snapshot.sourceGeneration = generation + 1; snapshot.appliedChangeId = changeId;
    snapshot.sourceVersions = [...versions, { generation: generation + 1, revision, source: structuredClone(source), at: now, changeId, impact: structuredClone(impact), changeHash, policyHash }];
    for (const run of snapshot.runs) if (!run.sourceSuperseded) {
      run.sourceSnapshot ??= structuredClone(project.source); run.sourceRevision ??= contentRevision(run.sourceSnapshot);
      run.sourceSuperseded = true; run.sourceSupersededAt = now; run.supersededByChangeId = changeId;
    }
    await this.#enqueue(snapshot, { baseRevision, generation });
    // No await between disk publication and the live field update. Queued callbacks retain these objects.
    for (const key of ['source', 'currentSourceRevision', 'sourceGeneration', 'sourceVersions', 'appliedChangeId', 'updatedAt']) project[key] = snapshot[key];
    for (const run of project.runs) {
      const saved = snapshot.runs.find(item => item.id === run.id);
      run.sourceSnapshot ??= saved.sourceSnapshot; run.sourceRevision ??= saved.sourceRevision;
      if (!run.sourceSuperseded) for (const key of ['sourceSuperseded', 'sourceSupersededAt', 'supersededByChangeId']) run[key] = saved[key];
    }
    return { revision, generation: generation + 1, changeId };
  }

  async flush(projectId) {
    if (projectId === undefined) { await Promise.all(this.queues.values()); return; }
    while (this.queues.has(projectId)) await this.queues.get(projectId);
  }
}
