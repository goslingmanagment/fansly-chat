export type AiProvider = 'anthropic' | 'openrouter';

export interface ModelPricing {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  cacheWrite5mUsdPerMillion?: number;
  cacheWrite1hUsdPerMillion?: number;
  cacheReadUsdPerMillion?: number;
}

export interface AiModelEntry {
  id: string;
  provider: AiProvider;
  providerModelId: string;
  providerLabel: string;
  label: string;
  description: string;
  pricing: ModelPricing;
  supportsPromptCache: boolean;
  costApproximate?: boolean;
  pricingNote?: string;
}

export const ANTHROPIC_PROVIDER: AiProvider = 'anthropic';
export const OPENROUTER_PROVIDER: AiProvider = 'openrouter';

export const DEFAULT_MODEL_ID = 'anthropic:claude-sonnet-4-6';
export const DEFAULT_FAN_SUMMARY_MODEL_ID = 'anthropic:claude-opus-4-6';

export const AI_MODELS: AiModelEntry[] = [
  {
    id: 'anthropic:claude-sonnet-4-6',
    provider: ANTHROPIC_PROVIDER,
    providerModelId: 'claude-sonnet-4-6',
    providerLabel: 'Anthropic Direct',
    label: 'Claude Sonnet 4.6',
    description: 'Recommended',
    supportsPromptCache: true,
    pricing: {
      inputUsdPerMillion: 3,
      cacheWrite5mUsdPerMillion: 3.75,
      cacheWrite1hUsdPerMillion: 6,
      cacheReadUsdPerMillion: 0.30,
      outputUsdPerMillion: 15,
    },
  },
  {
    id: 'anthropic:claude-sonnet-4-5',
    provider: ANTHROPIC_PROVIDER,
    providerModelId: 'claude-sonnet-4-5',
    providerLabel: 'Anthropic Direct',
    label: 'Claude Sonnet 4.5',
    description: 'Balanced',
    supportsPromptCache: true,
    pricing: {
      inputUsdPerMillion: 3,
      cacheWrite5mUsdPerMillion: 3.75,
      cacheWrite1hUsdPerMillion: 6,
      cacheReadUsdPerMillion: 0.30,
      outputUsdPerMillion: 15,
    },
  },
  {
    id: 'anthropic:claude-opus-4-6',
    provider: ANTHROPIC_PROVIDER,
    providerModelId: 'claude-opus-4-6',
    providerLabel: 'Anthropic Direct',
    label: 'Claude Opus 4.6',
    description: 'Best quality',
    supportsPromptCache: true,
    pricing: {
      inputUsdPerMillion: 15,
      cacheWrite5mUsdPerMillion: 18.75,
      cacheWrite1hUsdPerMillion: 30,
      cacheReadUsdPerMillion: 1.50,
      outputUsdPerMillion: 75,
    },
  },
  {
    id: 'anthropic:claude-opus-4-5',
    provider: ANTHROPIC_PROVIDER,
    providerModelId: 'claude-opus-4-5',
    providerLabel: 'Anthropic Direct',
    label: 'Claude Opus 4.5',
    description: 'Best quality (older)',
    supportsPromptCache: true,
    pricing: {
      inputUsdPerMillion: 15,
      cacheWrite5mUsdPerMillion: 18.75,
      cacheWrite1hUsdPerMillion: 30,
      cacheReadUsdPerMillion: 1.50,
      outputUsdPerMillion: 75,
    },
  },
  {
    id: 'anthropic:claude-haiku-4-5',
    provider: ANTHROPIC_PROVIDER,
    providerModelId: 'claude-haiku-4-5',
    providerLabel: 'Anthropic Direct',
    label: 'Claude Haiku 4.5',
    description: 'Fastest & cheapest',
    supportsPromptCache: true,
    pricing: {
      inputUsdPerMillion: 1,
      cacheWrite5mUsdPerMillion: 1.25,
      cacheWrite1hUsdPerMillion: 2,
      cacheReadUsdPerMillion: 0.10,
      outputUsdPerMillion: 5,
    },
  },
  {
    id: 'openrouter:google/gemini-3.1-pro-preview',
    provider: OPENROUTER_PROVIDER,
    providerModelId: 'google/gemini-3.1-pro-preview',
    providerLabel: 'OpenRouter',
    label: 'Gemini 3.1 Pro Preview',
    description: 'OpenRouter',
    supportsPromptCache: false,
    pricing: {
      inputUsdPerMillion: 2,
      outputUsdPerMillion: 12,
    },
  },
  {
    id: 'openrouter:x-ai/grok-4.20',
    provider: OPENROUTER_PROVIDER,
    providerModelId: 'x-ai/grok-4.20',
    providerLabel: 'OpenRouter',
    label: 'Grok 4.20',
    description: 'OpenRouter',
    supportsPromptCache: false,
    costApproximate: true,
    pricingNote: 'OpenRouter Grok cache-read pricing is approximate/unconfirmed for this registry entry; do not treat the placeholder USD rate as source-confirmed model pricing.',
    pricing: {
      inputUsdPerMillion: 1.25,
      cacheReadUsdPerMillion: 0.20,
      outputUsdPerMillion: 2.50,
    },
  },
  {
    id: 'openrouter:x-ai/grok-4.3',
    provider: OPENROUTER_PROVIDER,
    providerModelId: 'x-ai/grok-4.3',
    providerLabel: 'OpenRouter',
    label: 'Grok 4.3',
    description: 'OpenRouter',
    supportsPromptCache: false,
    costApproximate: true,
    pricingNote: 'Base-tier pricing; requests above 200k total tokens may cost more. OpenRouter Grok cache-read pricing is approximate/unconfirmed for this registry entry; do not treat the placeholder USD rate as source-confirmed model pricing.',
    pricing: {
      inputUsdPerMillion: 1.25,
      cacheReadUsdPerMillion: 0.20,
      outputUsdPerMillion: 2.50,
    },
  },
];

export const AI_MODEL_IDS = new Set(AI_MODELS.map((model) => model.id));
export const CLAUDE_MODELS = AI_MODELS.filter((model) => model.provider === ANTHROPIC_PROVIDER);
export const OPENROUTER_MODELS = AI_MODELS.filter((model) => model.provider === OPENROUTER_PROVIDER);
export const CLAUDE_MODEL_IDS = new Set(CLAUDE_MODELS.map((model) => model.id));
export const LEGACY_CLAUDE_MODEL_IDS = new Set(CLAUDE_MODELS.map((model) => model.providerModelId));

export const AI_MODEL_GROUPS: Array<{
  provider: AiProvider;
  label: string;
  models: AiModelEntry[];
}> = [
  {
    provider: ANTHROPIC_PROVIDER,
    label: 'Anthropic Direct',
    models: CLAUDE_MODELS,
  },
  {
    provider: OPENROUTER_PROVIDER,
    label: 'OpenRouter',
    models: OPENROUTER_MODELS,
  },
];

const MODELS_BY_ID = new Map(AI_MODELS.map((model) => [model.id, model]));
const ANTHROPIC_BY_PROVIDER_ID = new Map(
  CLAUDE_MODELS.map((model) => [model.providerModelId, model]),
);

export function normalizeModelId(modelId: string | null | undefined): string | null {
  const candidate = modelId?.trim();
  if (!candidate) {
    return null;
  }

  if (MODELS_BY_ID.has(candidate)) {
    return candidate;
  }

  const legacyAnthropic = ANTHROPIC_BY_PROVIDER_ID.get(candidate);
  if (legacyAnthropic) {
    return legacyAnthropic.id;
  }

  return null;
}

export function getModelEntry(modelId: string | null | undefined): AiModelEntry | null {
  const normalized = normalizeModelId(modelId);
  return normalized ? MODELS_BY_ID.get(normalized) ?? null : null;
}

export function getModelDisplayName(
  modelId: string | null | undefined,
  fallback = 'AI model',
): string {
  return getModelEntry(modelId)?.label ?? fallback;
}

export function isSupportedModelSelection(modelId: string | null | undefined): boolean {
  return Boolean(normalizeModelId(modelId));
}

export function isAnthropicModelSelection(modelId: string | null | undefined): boolean {
  return getModelEntry(modelId)?.provider === ANTHROPIC_PROVIDER;
}

export function isOpenRouterModelSelection(modelId: string | null | undefined): boolean {
  return getModelEntry(modelId)?.provider === OPENROUTER_PROVIDER;
}

export function modelSelectionsEquivalent(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  const normalizedLeft = normalizeModelId(left);
  const normalizedRight = normalizeModelId(right);
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}

export function getProviderModelId(modelId: string): string {
  return getModelEntry(modelId)?.providerModelId ?? modelId;
}

export function getAgencyHubModelId(modelId: string): string {
  const entry = getModelEntry(modelId);
  if (!entry) {
    return modelId;
  }
  return entry.provider === ANTHROPIC_PROVIDER ? entry.providerModelId : entry.id;
}
