import {
  ANTHROPIC_API_BASE_URL,
  DEFAULT_CLAUDE_PROVIDER,
  KIRO_API_BASE_URL,
} from './constants.js';
import type { ClaudeProvider, Settings } from './types.js';

type ClaudeSettingsSubset = Pick<Settings, 'claudeProvider' | 'anthropicApiKey' | 'kiroApiKey'>;

interface ClaudeProviderStaticConfig {
  displayName: string;
  apiKeyLabel: string;
  apiKeyHelperText: string;
  baseUrl: string;
  sendDangerousDirectBrowserAccessHeader: boolean;
  missingApiKeyMessage: string;
  invalidApiKeyMessage: string;
}

export interface ResolvedClaudeProviderConfig extends ClaudeProviderStaticConfig {
  provider: ClaudeProvider;
  apiKey: string;
  messagesUrl: string;
  settingsKey: 'anthropicApiKey' | 'kiroApiKey';
}

const PROVIDER_CONFIG: Record<ClaudeProvider, ClaudeProviderStaticConfig & {
  settingsKey: 'anthropicApiKey' | 'kiroApiKey';
}> = {
  anthropic: {
    displayName: 'Anthropic',
    apiKeyLabel: 'Anthropic API key',
    apiKeyHelperText: 'Regular Claude/Anthropic API key',
    baseUrl: ANTHROPIC_API_BASE_URL,
    sendDangerousDirectBrowserAccessHeader: true,
    missingApiKeyMessage: 'Anthropic API key not configured. Go to Settings to add it.',
    invalidApiKeyMessage: 'Invalid Anthropic API key. Check your key in Settings.',
    settingsKey: 'anthropicApiKey',
  },
  kiro: {
    displayName: 'Kiro',
    apiKeyLabel: 'Kiro API key',
    apiKeyHelperText: 'Kiro/AWStore API key',
    baseUrl: KIRO_API_BASE_URL,
    sendDangerousDirectBrowserAccessHeader: false,
    missingApiKeyMessage: 'Kiro API key not configured. Go to Settings to add it.',
    invalidApiKeyMessage: 'Invalid Kiro API key. Check your key in Settings.',
    settingsKey: 'kiroApiKey',
  },
};

export function normalizeClaudeProvider(value: string | null | undefined): ClaudeProvider {
  return value === 'kiro' ? 'kiro' : DEFAULT_CLAUDE_PROVIDER;
}

function normalizeLegacyBaseUrl(value: string | null | undefined): string {
  return String(value ?? '').trim().replace(/\/+$/, '');
}

export function inferClaudeProviderFromLegacyBaseUrl(
  value: string | null | undefined,
): ClaudeProvider | null {
  const normalized = normalizeLegacyBaseUrl(value);
  if (!normalized) {
    return null;
  }

  if (normalized === KIRO_API_BASE_URL) {
    return 'kiro';
  }

  if (normalized === ANTHROPIC_API_BASE_URL) {
    return 'anthropic';
  }

  return null;
}

export function getClaudeProviderConfig(provider: ClaudeProvider): typeof PROVIDER_CONFIG.anthropic {
  return PROVIDER_CONFIG[normalizeClaudeProvider(provider)];
}

export function resolveClaudeProviderSettings(
  settings: Partial<ClaudeSettingsSubset> | null | undefined,
): ResolvedClaudeProviderConfig {
  const provider = normalizeClaudeProvider(settings?.claudeProvider);
  const config = getClaudeProviderConfig(provider);
  const apiKey = String(settings?.[config.settingsKey] ?? '').trim();

  return {
    ...config,
    provider,
    apiKey,
    messagesUrl: `${config.baseUrl}/messages`,
  };
}

export function hasClaudeApiKey(settings: Partial<ClaudeSettingsSubset> | null | undefined): boolean {
  return Boolean(resolveClaudeProviderSettings(settings).apiKey);
}

export function getMissingApiKeyMessage(provider: ClaudeProvider): string {
  return getClaudeProviderConfig(provider).missingApiKeyMessage;
}

export function getInvalidApiKeyMessage(provider: ClaudeProvider): string {
  return getClaudeProviderConfig(provider).invalidApiKeyMessage;
}
