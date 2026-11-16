export const DEFAULT_STACK = Object.freeze({ frontend: 'HTML/CSS/JS', backend: 'Node.js', storage: 'SQLite' });
export const PLATFORM_DEFAULTS = Object.freeze({ version: 'web-v1', delivery: '浏览器网页应用',
  description: '当前统一采用原生HTML/CSS/JavaScript、Node.js与SQLite。Windows通过浏览器使用，不生成原生桌面安装包。' });
// Retire only explicit technology-selection questions, never arbitrary backend/data rules.
export function technicalQuestion(question) {
  if (typeof question !== 'string') return false;
  if (['确定界面形式和前端技术栈，以及需要支持的终端。','确定是否需要独立后端，以及接口边界和实现语言。'].includes(question)) return true;
  const value=question.replace(/[\s？?。！!]/gu,'');
  const labels='技术栈|技术选型|技术方案|前端框架|前端技术|后端语言|后端技术|服务端语言|开发语言|编程语言|数据库选型|数据库类型';
  const list=`(?:${labels})(?:(?:和|与|、|及)(?:${labels}))*`;
  return new RegExp(`^(?:请问)?${list}(?:是什么|有哪些|如何选择|怎么选|如何确定|(?:是否有|有无|有何|有什么)?(?:偏好|限制|要求))?$`,'u').test(value)
    || /^(?:前端|后端|服务端|数据库)(?:采用|使用|选用|选择|用|选)(?:什么|哪种|哪个|哪些|何种)(?:技术|框架|语言|数据库|存储方案)?$/u.test(value);
}
export function applyPlatformDefaults(raw) {
  const spec = { ...raw, stack: { ...DEFAULT_STACK }, platformDefaults: { ...PLATFORM_DEFAULTS } };
  if (Array.isArray(spec.questions)) spec.questions = spec.questions.filter(q => !technicalQuestion(q));
  if (Array.isArray(spec.requirements) && !spec.requirements.length && Array.isArray(spec.questions) && !spec.questions.length) spec.questions = ['首版需要哪些核心功能？'];
  return spec;
}
