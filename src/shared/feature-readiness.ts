import { getModelEntry } from './model-registry.js';
import type { Settings, TabUiState } from './types.js';

/**
 * Maps each feature to the provider of its selected model. Shared by the
 * background operation coordinator and the popup/options runtime API so the
 * tab UI state and popup gating never drift apart.
 */
export function buildModelProviderByFeature(
  settings: Settings,
): TabUiState['modelProviderByFeature'] {
  return Object.fromEntries(
    Object.entries(settings.featureModels).flatMap(([feature, modelId]) => {
      const provider = getModelEntry(modelId)?.provider;
      return provider ? [[feature, provider]] : [];
    }),
  ) as TabUiState['modelProviderByFeature'];
}

/**
 * Maps each feature to whether the API key for its selected model's provider
 * is configured. When the provider is unknown, either key counts as ready.
 */
export function buildApiKeyReadyByFeature(
  settings: Settings,
): TabUiState['apiKeyReadyByFeature'] {
  return Object.fromEntries(
    Object.entries(settings.featureModels).map(([feature, modelId]) => {
      const provider = getModelEntry(modelId)?.provider;
      if (provider === 'anthropic') {
        return [feature, Boolean(settings.claudeApiKey)];
      }
      if (provider === 'openrouter') {
        return [feature, Boolean(settings.openRouterApiKey)];
      }
      return [feature, Boolean(settings.claudeApiKey || settings.openRouterApiKey)];
    }),
  ) as TabUiState['apiKeyReadyByFeature'];
}
