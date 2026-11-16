// Only controller-owned reasons become public text; never forward provider errors.
const messages = {
  requirement_quote_not_found: '模型生成的需求引用无法在原始需求或你保存的回答中找到，规格未被接受。',
  invalid_json: '模型返回的内容不是完整、可解析的JSON规格，尚未生成有效规格。',
  invalid_model_response: '模型返回的规格不符合结构或引用要求，尚未生成有效规格。',
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
export function specificationFailure(code, reason, requirementIndex) {
  const kind = Object.hasOwn(messages, reason) ? reason : Object.hasOwn(messages, code) ? code : 'invalid_model_response';
  const index = Number.isInteger(requirementIndex) && requirementIndex >= 1 && requirementIndex <= 80 ? requirementIndex : null;
  return { reason: kind, message: `${kind === 'requirement_quote_not_found' && index ? `第${index}条需求：` : ''}${messages[kind]}`, ...(index ? { requirementIndex: index } : {}) };
}
