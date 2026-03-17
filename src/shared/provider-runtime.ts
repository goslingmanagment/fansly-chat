import { BUILD_TIME } from './constants.js';
import {
  getClaudeProviderHostPermissionPattern,
  resolveClaudeProviderSettings,
} from './claude-api.js';
import type {
  ClaudeProvider,
  ProviderCapabilityStatus,
  ProviderDiagnostics,
  Settings,
} from './types.js';

type ProviderSettingsSubset = Pick<
  Settings,
  'claudeProvider' | 'anthropicApiKey' | 'kiroApiKey'
>;

function resolveCapabilityStatus(
  hasApiKey: boolean,
  hostPermissionGranted: boolean,
): ProviderCapabilityStatus {
  if (!hasApiKey) {
    return 'missing_api_key';
  }

  return hostPermissionGranted ? 'ready' : 'host_access_missing';
}

export function buildHostAccessMissingDetail(
  provider: ClaudeProvider,
  requestHost: string,
): string {
  const providerLabel = provider === 'kiro' ? 'Kiro' : 'Anthropic';
  return `${providerLabel}: Host access to ${requestHost} is not active. Firefox may be treating ${requestHost} as a normal browser request. Reload or reinstall the extension, then run the provider self-test in Settings.`;
}

export async function hasOriginPermission(pattern: string): Promise<boolean> {
  const permissionsApi = (globalThis as { browser?: typeof browser }).browser
    ?.permissions;
  if (!permissionsApi?.contains) {
    return true;
  }

  try {
    return await permissionsApi.contains({ origins: [pattern] });
  } catch {
    return false;
  }
}

export async function getProviderDiagnostics(
  settings: Partial<ProviderSettingsSubset> | null | undefined,
): Promise<ProviderDiagnostics> {
  const resolvedProvider = resolveClaudeProviderSettings(settings);
  const hostPermissionPattern = getClaudeProviderHostPermissionPattern(
    resolvedProvider.provider,
  );
  const hasApiKey = Boolean(resolvedProvider.apiKey);
  const hostPermissionGranted = await hasOriginPermission(hostPermissionPattern);

  return {
    provider: resolvedProvider.provider,
    displayName: resolvedProvider.displayName,
    requestUrl: resolvedProvider.messagesUrl,
    requestHost: new URL(resolvedProvider.messagesUrl).host,
    hostPermissionPattern,
    hostPermissionGranted,
    hasApiKey,
    capabilityStatus: resolveCapabilityStatus(
      hasApiKey,
      hostPermissionGranted,
    ),
    buildTime: BUILD_TIME,
  };
}
