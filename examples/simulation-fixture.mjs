import * as planner from '../lib/planner.mjs';

// Explicit deterministic demo fixture, not a real PM model response or real implementation.
export const simulationTasks = [
  ['A', [], '基础契约'], ['B', ['A'], '分支B'], ['C', ['A'], '分支C'], ['D', ['B', 'C'], '人工检查'], ['E', ['D'], '后续任务'],
].map(([id, dependsOn, title]) => ({ id, title, description: `演示任务 ${id}：${title}`, dependsOn,
  requirementIds: ['R1'], suggestedFiles: [`src/${id.toLowerCase()}.mjs`], inputs: ['已确认规格', ...dependsOn.map(id => `任务${id}模拟结果`)],
  outputs: [`任务${id}模拟产出`], acceptance: [`核对${title}模拟结果`], requiresConfirmation: id === 'D' }));

export const simulationPlanner = { ...planner,
  analyzeRequirements: content => ({ title: '模拟编排验收示例', summary: '仅验证调度状态，不生成业务代码。', goals: ['验证任务依赖编排'], roles: [],
    constraints: ['模拟完成不能作为真实验收'], assumptions: [], questions: [], acceptanceScenarios: ['A→[B,C]→D→E，D人工确认'],
    stack: { frontend: '原生HTML', backend: 'Node.js', storage: 'SQLite' },
    requirements: [{ id: 'R1', title: '任务依赖演示', description: content, sourceQuote: content, acceptance: ['正确推进模拟状态'] }] }),
  generateTasks: () => structuredClone(simulationTasks),
};
