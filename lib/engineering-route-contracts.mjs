import { HttpError } from './documents.mjs';
import { assertEngineeringAlignment, engineeringTasks } from './engineering-planner.mjs';
import { validateEngineeringPlan, ENGINEERING_LIMITS } from './engineering-plan.mjs';
import { copyBrowserScenarioData } from './browser-scenario-contract.mjs';

const fields = ['id', 'roles', 'request', 'response'];

export function reviseEngineeringRouteContracts(run, input) {
  const current = assertEngineeringAlignment(run);
  try {
    const changes = copyBrowserScenarioData(input, ENGINEERING_LIMITS.proposalBytes);
    const routes = new Map(current.proposal.routes.map(route => [route.id, route]));
    const roleOrder = current.roleDefinitions.map(role => role.id);
    if (!Array.isArray(changes) || !changes.length || changes.length > routes.size) throw new Error();
    const edited = new Set();
    for (const edit of changes) {
      if (!edit || typeof edit !== 'object' || Array.isArray(edit)
        || Object.keys(edit).length < 2 || Object.keys(edit).some(key => !fields.includes(key))
        || !routes.has(edit.id) || edited.has(edit.id)) throw new Error();
      edited.add(edit.id);
      const route = routes.get(edit.id);
      const revised = { ...route };
      for (const field of ['request', 'response']) {
        if (!Object.hasOwn(edit, field)) continue;
        if (typeof edit[field] !== 'string') throw new Error();
        revised[field] = edit[field].trim();
      }
      if (Object.hasOwn(edit, 'roles')) {
        if (!Array.isArray(edit.roles) || new Set(edit.roles).size !== edit.roles.length
          || edit.roles.some(role => !roleOrder.includes(role))) throw new Error();
        const selected = new Set(edit.roles);
        if (selected.size !== route.roles.length || !route.roles.every(role => selected.has(role))) {
          revised.roles = roleOrder.filter(role => selected.has(role));
        }
      }
      routes.set(edit.id, revised);
    }
    const proposal = { ...current.proposal, routes: [...routes.values()] };
    const engineeringPlan = validateEngineeringPlan({ proposal, spec: run.spec, binding: current.binding });
    if (engineeringPlan.hash === current.hash) throw new Error();
    return { engineeringPlan, tasks: engineeringTasks(engineeringPlan) };
  } catch {
    throw new HttpError(400, '接口修订无效。请选择现有接口，对请求、响应或已确认角色作出实际修改。');
  }
}
