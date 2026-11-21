import { createEngineeringModel } from './engineering-model.mjs';

export function modelConfigured(config) {
  try {
    const url = new URL(config.baseUrl);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
      && !!config.model?.trim() && (!!config.apiKey?.trim() || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  } catch { return false; }
}

/** Each native request owns a snapshot; returning its original Promise retains transport evidence. */
export function createAgentPlanner(planner, settings) {
  return { ...planner,
    getModelConfig() {
      try {
        const config = settings.resolve('spec');
        return { configured: modelConfigured(config), model: config.model, baseUrl: config.baseUrl };
      } catch { return { configured: false, model: '', baseUrl: '' }; }
    },
    analyzeWithModel(source, name, options = {}) {
      return planner.analyzeWithModel(source, name, { ...options, config: settings.resolve('spec') });
    },
    createEngineeringModel(options = {}) {
      return (planner.createEngineeringModel ?? createEngineeringModel)({ ...options, config: settings.resolve('engineering') });
    },
  };
}
