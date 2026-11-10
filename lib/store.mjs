import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { HttpError } from './documents.mjs';

export class ProjectStore {
  constructor(directory) { this.directory = path.resolve(directory); this.projects = new Map(); this.queues = new Map(); }

  async init() {
    await mkdir(this.directory, { recursive: true });
    for (const file of await readdir(this.directory)) {
      if (!/^[0-9a-f-]{36}\.json$/u.test(file)) continue;
      const project = JSON.parse(await readFile(path.join(this.directory, file), 'utf8'));
      if (!project.id || `${project.id}.json` !== file || !Array.isArray(project.runs)) throw new Error(`项目存档格式无效：${file}`);
      this.projects.set(project.id, project);
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

  async create({ name, source }) {
    const now = new Date().toISOString();
    const project = { id: randomUUID(), name, source, createdAt: now, updatedAt: now, runs: [] };
    this.projects.set(project.id, project);
    await this.save(project);
    return project;
  }

  async save(project) {
    project.updatedAt = new Date().toISOString();
    const contents = JSON.stringify(project, null, 2);
    const previous = this.queues.get(project.id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      const target = path.join(this.directory, `${project.id}.json`);
      const temporary = `${target}.${randomUUID()}.tmp`;
      await writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, target);
    });
    this.queues.set(project.id, next);
    try { await next; } finally { if (this.queues.get(project.id) === next) this.queues.delete(project.id); }
  }

  async flush() { await Promise.all(this.queues.values()); }
}
