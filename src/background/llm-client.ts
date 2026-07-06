import { ChatGooseError } from '../shared/errors.js';
import {
  ANTHROPIC_PROVIDER,
  getModelEntry,
  OPENROUTER_PROVIDER,
} from '../shared/model-registry.js';
import type {
  LlmUsageMetrics,
  FeatureType,
  LlmReasoningSignal,
  PromptTextBlock,
  ReasoningEffort,
  Settings,
} from '../shared/types.js';
import type { AnthropicClient } from './anthropic-client.js';
import type { OpenRouterClient } from './openrouter-client.js';

export interface LlmStreamArgs {
  settings: Pick<Settings, 'claudeApiKey' | 'openRouterApiKey'>;
  model: string;
  temperature: number;
  systemBlocks: PromptTextBlock[];
  userBlocks: PromptTextBlock[];
  feature: FeatureType;
  reasoningEffort: ReasoningEffort;
  signal: AbortSignal;
  onText: (text: string) => void;
  onUsage?: (usage: LlmUsageMetrics) => void;
  onProgress?: () => void;
  onReasoningObserved?: (signal: LlmReasoningSignal) => void;
  onReasoningDelta?: (text: string) => void;
  onStopReason?: (stopReason: string | null) => void;
}

export class LlmClient {
  constructor(
    private readonly anthropicClient: AnthropicClient,
    private readonly openRouterClient: OpenRouterClient,
  ) {}

  async streamMessage(args: LlmStreamArgs): Promise<string> {
    const model = getModelEntry(args.model);
    if (!model) {
      throw new ChatGooseError('model_unavailable');
    }

    if (model.provider === ANTHROPIC_PROVIDER) {
      if (!args.settings.claudeApiKey) {
        throw new ChatGooseError('missing_api_key', {
          details: { provider: ANTHROPIC_PROVIDER },
        });
      }
      return this.anthropicClient.streamMessage({
        ...args,
        apiKey: args.settings.claudeApiKey,
        model: model.providerModelId,
      });
    }

    if (model.provider === OPENROUTER_PROVIDER) {
      if (!args.settings.openRouterApiKey) {
        throw new ChatGooseError('missing_api_key', {
          details: { provider: OPENROUTER_PROVIDER },
        });
      }
      return this.openRouterClient.streamMessage({
        ...args,
        apiKey: args.settings.openRouterApiKey,
        model: model.providerModelId,
      });
    }

    throw new ChatGooseError('model_unavailable');
  }
}
