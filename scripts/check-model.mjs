import { loadEnv } from '../server.mjs';
import { analyzeWithModel, getModelConfig } from '../lib/planner.mjs';

await loadEnv();
const config = getModelConfig();
if (!config.configured) {
  console.error('模型配置未完成。请在本地 .env 中填写 LLM_BASE_URL、LLM_MODEL 和 LLM_API_KEY；不要将密钥发到聊天或提交 Git。');
  process.exitCode = 2;
} else {
  console.log(`正在检查模型连接：${config.model}（不输出密钥）`);
  try {
    const spec = await analyzeWithModel('用户可以新增待办事项，并在刷新页面后继续看到已保存的事项。', '模型连接检查');
    console.log(`连接与 JSON 规格校验通过，返回 ${spec.requirements.length} 条可追溯需求。`);
  } catch (error) {
    // Planner errors are deliberately sanitized: never print the raw upstream response.
    console.error(`检查未通过：${error.message}`);
    process.exitCode = 1;
  }
}
