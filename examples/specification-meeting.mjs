import * as planner from '../lib/planner.mjs';

export const reservationMeetingSource = '用户可以预约设备并取消预约。系统应防止同一时段重复预约。';
export const reservationMeetingPlanner = { ...planner, getModelConfig: () => ({ configured: false }),
  analyzeWithModel: () => { throw new Error('本夹具禁止调用付费模型'); },
  analyzeRequirements: () => ({ title: '设备预约规格评审', summary: '明确取消权限、时段释放及同版本评审门禁。', goals: ['预约、取消与时段一致性'],
    roles: ['普通用户', '管理员'], constraints: ['非法请求不得修改已有记录'], assumptions: [], questions: [], acceptanceScenarios: ['预约→取消→他人重新预约'],
    stack: { frontend: 'HTML/CSS/JavaScript', backend: 'Node.js', storage: 'SQLite' }, requirements: [
      { id: 'R-CANCEL', title: '预约与取消', description: '用户预约并取消设备时段，取消权限和释放时机需要业务裁决。',
        sourceQuote: '用户可以预约设备并取消预约。', acceptance: ['有效预约保存成功，取消更新状态。'], kind: 'functional' },
      { id: 'R-UNIQUE', title: '时段唯一性', description: '同一时段不允许重复有效预约。', sourceQuote: '系统应防止同一时段重复预约。',
        acceptance: ['并发预约同一时段时仅一个成功，失败者收到明确反馈。'], kind: 'functional' },
    ] }),
};
