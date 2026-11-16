// Only controller-owned reasons become public text; never forward provider errors.
const messages = {
  requirement_quote_not_found: '模型生成的需求引用无法在原始需求或你保存的回答中找到，规格未被接受。',
  invalid_json: '模型返回的内容不是完整、可解析的JSON规格，尚未生成有效规格。',
  invalid_model_response: '模型返回的规格不符合结构或引用要求，尚未生成有效规格。',
  missing_requirements: '模型没有返回可独立实施的需求列表，尚未生成有效规格。',
  too_many_requirements: '模型返回的需求超过80条上限，当前需求需要拆分或缩小首版范围。',
  malformed_requirement: '模型返回的需求条目缺少标题、描述或验收条件，尚未生成有效规格。',
  missing_acceptance: '模型返回的需求缺少可检查的验收条件，尚未生成有效规格。',
  malformed_spec_fields: '模型返回的规格字段格式不正确，尚未生成有效规格。',
  missing_title_or_summary: '模型返回的规格缺少项目标题或摘要，尚未生成有效规格。',
  duplicate_requirement_id: '模型返回了重复的需求编号，尚未生成有效规格。',
  no_requirements_or_questions: '模型没有从当前需求中提取到可独立实施的需求，也没有提出可回答的补充问题。这通常表示目标用户、首版功能范围或验收方式还不够明确。',
  missing_platform_stack: '规格缺少平台技术边界；当前版本会使用平台默认网页方案。',
  model_timeout: '模型未在本次时限内返回有效规格，调用用量可能仍待核对。',
  transport_error: '连接模型服务失败，请检查服务地址或网络。',
  http_error: '模型服务拒绝了请求，请核对服务配置及账户状态。',
  receipt_failed: '模型响应的本地保存未完成，未发布规格，请检查本地存储。',
  persistence_failed: '运行记录保存失败，未发布规格，请检查本地存储。',
  abnormal_finish: '模型未正常结束，可能输出被截断；不完整规格未被接受。',
  credential_response: '模型返回了受保护的凭据信息，已遮蔽并拒绝该结果。',
  invalid_input: '模型服务配置或请求参数无效，请核对本地服务配置。',
  response_error: '模型服务返回的响应无法读取或解析，未生成有效规格。',
  response_too_large: '模型响应超过本次大小限制，未接受该响应。',
  cancelled: '规格整理已中断；这不表示远端服务已经确认停止。',
  stale_revision: '需求或规格版本已变化，旧响应未计入当前结果。',
  service_restart: '服务重启中断了规格整理，原调用状态和用量保留。',
  saved_response_valid: '模型已经返回规格；之前的引用格式校验未接受它。当前版本可以免费重新校验已保存响应。',
};

const labels = {
  requirement_quote_not_found: '需求引用无法追溯',
  invalid_json: '模型输出不是完整JSON',
  invalid_model_response: '规格未通过校验',
  missing_requirements: '没有可用需求',
  too_many_requirements: '需求数量过多',
  malformed_requirement: '需求条目不完整',
  missing_acceptance: '缺少验收条件',
  malformed_spec_fields: '规格字段格式不正确',
  missing_title_or_summary: '缺少标题或摘要',
  duplicate_requirement_id: '需求编号重复',
  no_requirements_or_questions: '需求信息不足',
  missing_platform_stack: '缺少平台方案',
  model_timeout: '模型响应超时',
  transport_error: '模型连接失败',
  http_error: '模型服务拒绝请求',
  receipt_failed: '响应保存失败',
  persistence_failed: '运行记录保存失败',
  abnormal_finish: '模型输出未正常结束',
  credential_response: '响应含受保护凭据',
  invalid_input: '模型配置无效',
  response_error: '模型响应无法解析',
  response_too_large: '模型响应过大',
  cancelled: '规格整理已中断',
  stale_revision: '输入版本已变化',
  service_restart: '服务重启中断',
  saved_response_valid: '保存响应可重新校验',
};

const fieldDefinitions = {
  goal: { id: 'goal', label: '项目目标', question: '这个软件主要解决什么问题、希望达到什么目标？', placeholder: '例如：让团队在一个网页里提交、分派和跟进工单。', maxLength: 2000 },
  users: { id: 'users', label: '使用者与角色', question: '谁会使用这个软件？有哪些角色或权限差异？', placeholder: '例如：员工提交工单，管理员分派和关闭工单。', maxLength: 2000 },
  scope: { id: 'scope', label: '首版功能范围', question: '首版必须包含哪些功能？请按模块逐条列出。', placeholder: '例如：登录、创建工单、分派、状态流转、评论、筛选。', maxLength: 4000 },
  exclude: { id: 'exclude', label: '首版不包含', question: '首版明确不包含哪些内容？', placeholder: '例如：首版不包含移动端原生应用和第三方支付。', maxLength: 2000 },
  acceptance: { id: 'acceptance', label: '验收标准', question: '如何判断首版完成？请写出可检查的结果或步骤。', placeholder: '例如：管理员可以分派工单，员工能看到状态变化。', maxLength: 4000 },
  evidence: { id: 'evidence', label: '需求依据说明', question: index => `模型为${index ? `第 ${index} 条需求` : '一条需求'}引用的原文无法在需求或回答中找到。请说明这条需求是否成立；如果成立，请写出支持它的依据，或改用你自己的表述。`, placeholder: '例如：首版只做网页端；这条需求来自附件中的“仅支持浏览器访问”。', maxLength: 4000 },
  note: { id: 'note', label: '其他说明', question: '其他需要补充的范围、限制或修正说明。', placeholder: '例如：首版只支持单个团队使用，暂不开放外部协作。', maxLength: 4000 },
};

const profiles = {
  requirement_quote_not_found: ['evidence', 'scope', 'note'],
  no_requirements_or_questions: ['goal', 'users', 'scope', 'acceptance'],
  missing_requirements: ['goal', 'users', 'scope'],
  too_many_requirements: ['exclude', 'note'],
  malformed_requirement: ['scope', 'acceptance', 'note'],
  missing_acceptance: ['acceptance', 'note'],
  malformed_spec_fields: ['scope', 'note'],
  missing_title_or_summary: ['goal', 'scope'],
  duplicate_requirement_id: ['scope', 'note'],
  invalid_model_response: ['goal', 'users', 'scope', 'acceptance', 'note'],
  invalid_json: ['scope', 'note'],
  abnormal_finish: ['scope', 'note'],
};

const safeLabel = value => typeof value === 'string' ? Array.from(value.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim()).slice(0, 80).join('') : '';
const safeDetail = value => typeof value === 'string' ? Array.from(value.replace(/[\u0000-\u001f\u007f]/gu, ' ').trim()).slice(0, 300).join('') : '';

export function specificationRepairField(id, requirementIndex) {
  const field = fieldDefinitions[id];
  if (!field) return null;
  return { ...field, question: typeof field.question === 'function' ? field.question(requirementIndex) : field.question };
}

export function specificationFailure(code, reason, requirementIndex, extra = {}) {
  const kind = Object.hasOwn(messages, reason) ? reason : Object.hasOwn(messages, code) ? code : 'invalid_model_response';
  const index = Number.isInteger(requirementIndex) && requirementIndex >= 1 && requirementIndex <= 80 ? requirementIndex : null;
  const title = safeLabel(extra?.requirementTitle);
  const field = safeLabel(extra?.field), detail = safeDetail(extra?.detail);
  const position = kind === 'requirement_quote_not_found' && index ? `第${index}条需求${title ? `「${title}」` : ''}：` : '';
  const profile = profiles[kind] ?? null;
  return {
    reason: kind,
    label: labels[kind] || labels.invalid_model_response,
    message: `${position}${messages[kind]}`,
    ...(index ? { requirementIndex: index } : {}),
    ...(title && kind !== 'requirement_quote_not_found' ? { requirementTitle: title } : {}),
    ...(field ? { field } : {}),
    ...(detail ? { detail } : {}),
    repairable: Boolean(profile),
    repairFields: (profile || []).map(id => specificationRepairField(id, index)).filter(Boolean),
  };
}
