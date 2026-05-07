import type { FeatureType } from './types.js';
import {
  ANTHROPIC_PROVIDER,
  getModelEntry,
  OPENROUTER_PROVIDER,
} from './model-registry.js';

const ANTHROPIC_ADAPTIVE_THINKING_MODELS = new Set([
  'claude-sonnet-4-6',
  'claude-opus-4-6',
]);

const ANTHROPIC_ADAPTIVE_THINKING_MAX_TOKENS: Partial<Record<FeatureType, number>> = {
  'fast-reply': 8000,
  'improve-draft': 8000,
  'help-me': 16000,
  'fan-summary': 24000,
  'chat-review': 16000,
  ping: 8000,
  'hi-greeting': 8000,
};

const OPENROUTER_GEMINI_THINKING_MAX_TOKENS: Partial<Record<FeatureType, number>> = {
  'fast-reply': 1600,
  'improve-draft': 1600,
  'hi-greeting': 1600,
  ping: 1600,
  'help-me': 2000,
};

export function supportsAnthropicAdaptiveThinking(providerModelId: string): boolean {
  return ANTHROPIC_ADAPTIVE_THINKING_MODELS.has(providerModelId);
}

export function getAnthropicAdaptiveThinkingMaxTokens(
  feature: FeatureType,
): number | undefined {
  return ANTHROPIC_ADAPTIVE_THINKING_MAX_TOKENS[feature];
}

export function isOpenRouterGeminiModel(providerModelId: string): boolean {
  return providerModelId.startsWith('google/gemini-');
}

export function getOpenRouterGeminiThinkingMaxTokens(
  feature: FeatureType,
): number | undefined {
  return OPENROUTER_GEMINI_THINKING_MAX_TOKENS[feature];
}

export function supportsOpenRouterGeminiThinking(
  providerModelId: string,
  feature: FeatureType,
): boolean {
  return Boolean(
    isOpenRouterGeminiModel(providerModelId) &&
      getOpenRouterGeminiThinkingMaxTokens(feature),
  );
}

export function supportsModelReasoningConfig(
  modelId: string | null | undefined,
  feature: FeatureType,
): boolean {
  const model = getModelEntry(modelId);
  if (!model) {
    return false;
  }

  if (model.provider === ANTHROPIC_PROVIDER) {
    return supportsAnthropicAdaptiveThinking(model.providerModelId);
  }

  if (model.provider === OPENROUTER_PROVIDER) {
    return supportsOpenRouterGeminiThinking(model.providerModelId, feature);
  }

  return false;
}
