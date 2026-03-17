import type { ClaudeProvider, FeatureType } from './types.js';

export interface ClaudeModelEntry {
  id: string;
  label: string;
  description: string;
  apiModelId: string;
  isDefault: boolean;
}

interface ClaudeModelProviderDefinition {
  apiModelId: string;
  description: string;
  isDefault?: boolean;
}

interface ClaudeModelDefinition {
  id: string;
  label: string;
  providers: Partial<Record<ClaudeProvider, ClaudeModelProviderDefinition>>;
}

export interface ModelSelectionChange {
  feature: FeatureType;
  fromModelId: string;
  toModelId: string;
}

const FEATURE_TYPES: FeatureType[] = [
  'fast-reply',
  'help-me',
  'fan-summary',
  'chat-review',
  'ping',
];

const CLAUDE_MODEL_DEFINITIONS: ClaudeModelDefinition[] = [
  {
    id: 'claude-sonnet-4-6',
    label: 'Sonnet 4.6',
    providers: {
      anthropic: {
        apiModelId: 'claude-sonnet-4-6',
        description: 'Recommended',
        isDefault: true,
      },
    },
  },
  {
    id: 'claude-sonnet-4-5',
    label: 'Sonnet 4.5',
    providers: {
      anthropic: {
        apiModelId: 'claude-sonnet-4-5',
        description: 'Balanced',
      },
      kiro: {
        apiModelId: 'claude-sonnet-4-5',
        description: 'Recommended',
        isDefault: true,
      },
    },
  },
  {
    id: 'claude-sonnet-4',
    label: 'Sonnet 4',
    providers: {
      kiro: {
        apiModelId: 'claude-sonnet-4',
        description: 'Balanced (older)',
      },
    },
  },
  {
    id: 'claude-opus-4-6',
    label: 'Opus 4.6',
    providers: {
      anthropic: {
        apiModelId: 'claude-opus-4-6',
        description: 'Best quality',
      },
      kiro: {
        apiModelId: 'claude-opus-4-6',
        description: 'Best quality',
      },
    },
  },
  {
    id: 'claude-opus-4-5',
    label: 'Opus 4.5',
    providers: {
      anthropic: {
        apiModelId: 'claude-opus-4-5',
        description: 'Best quality (older)',
      },
      kiro: {
        apiModelId: 'claude-opus-4-5',
        description: 'Best quality (older)',
      },
    },
  },
  {
    id: 'claude-haiku-4-5',
    label: 'Haiku 4.5',
    providers: {
      anthropic: {
        apiModelId: 'claude-haiku-4-5',
        description: 'Fastest & cheapest',
      },
    },
  },
  {
    id: 'claude-3-5-haiku',
    label: 'Haiku 3.5',
    providers: {
      kiro: {
        apiModelId: 'claude-3-5-haiku',
        description: 'Fastest & cheapest',
      },
    },
  },
];

const MODEL_BY_ID = new Map(CLAUDE_MODEL_DEFINITIONS.map((model) => [model.id, model]));

export const DEFAULT_MODEL_ID = 'claude-sonnet-4-6';

export const CLAUDE_MODELS: ClaudeModelEntry[] = CLAUDE_MODEL_DEFINITIONS.flatMap((model) => {
  const providerConfig = model.providers.anthropic ?? model.providers.kiro;
  if (!providerConfig) {
    return [];
  }
  return [{
    id: model.id,
    label: model.label,
    description: providerConfig.description,
    apiModelId: providerConfig.apiModelId,
    isDefault: Boolean(providerConfig.isDefault),
  }];
});

export const CLAUDE_MODEL_IDS = new Set(CLAUDE_MODEL_DEFINITIONS.map((model) => model.id));

export const DEFAULT_MODEL_ID_BY_PROVIDER: Record<ClaudeProvider, string> = {
  anthropic: 'claude-sonnet-4-6',
  kiro: 'claude-sonnet-4-5',
};

export function getDefaultModelId(provider: ClaudeProvider): string {
  return DEFAULT_MODEL_ID_BY_PROVIDER[provider];
}

export function getDefaultFeatureModels(provider: ClaudeProvider): Record<FeatureType, string> {
  const defaultModelId = getDefaultModelId(provider);
  return {
    'fast-reply': defaultModelId,
    'help-me': defaultModelId,
    'fan-summary': defaultModelId,
    'chat-review': defaultModelId,
    'ping': defaultModelId,
  };
}

export const DEFAULT_FEATURE_MODELS: Record<FeatureType, string> =
  getDefaultFeatureModels('anthropic');

export function getModelsForProvider(provider: ClaudeProvider): ClaudeModelEntry[] {
  return CLAUDE_MODEL_DEFINITIONS.flatMap((model) => {
    const providerConfig = model.providers[provider];
    if (!providerConfig) {
      return [];
    }
    return [{
      id: model.id,
      label: model.label,
      description: providerConfig.description,
      apiModelId: providerConfig.apiModelId,
      isDefault: Boolean(providerConfig.isDefault),
    }];
  });
}

export function isModelAvailable(provider: ClaudeProvider, modelId: string): boolean {
  return Boolean(MODEL_BY_ID.get(modelId)?.providers[provider]);
}

export function resolveProviderModelId(
  provider: ClaudeProvider,
  modelId: string,
): string | null {
  return MODEL_BY_ID.get(modelId)?.providers[provider]?.apiModelId ?? null;
}

export function getModelLabel(modelId: string): string {
  return MODEL_BY_ID.get(modelId)?.label ?? modelId;
}

export function getModelDescription(
  provider: ClaudeProvider,
  modelId: string,
): string | null {
  return MODEL_BY_ID.get(modelId)?.providers[provider]?.description ?? null;
}

export function formatModelOptionLabel(provider: ClaudeProvider, modelId: string): string {
  const label = getModelLabel(modelId);
  const description = getModelDescription(provider, modelId);
  return description ? `${label} \u2014 ${description}` : label;
}

export function normalizeFeatureModelsForProvider(
  provider: ClaudeProvider,
  featureModels: Partial<Record<FeatureType, string>> | null | undefined,
): {
  featureModels: Record<FeatureType, string>;
  changes: ModelSelectionChange[];
} {
  const defaults = getDefaultFeatureModels(provider);
  const nextFeatureModels = { ...defaults };
  const changes: ModelSelectionChange[] = [];

  for (const feature of FEATURE_TYPES) {
    const candidate = featureModels?.[feature];
    if (candidate && isModelAvailable(provider, candidate)) {
      nextFeatureModels[feature] = candidate;
      continue;
    }

    if (candidate && candidate !== defaults[feature]) {
      changes.push({
        feature,
        fromModelId: candidate,
        toModelId: defaults[feature],
      });
    }
  }

  return {
    featureModels: nextFeatureModels,
    changes,
  };
}
