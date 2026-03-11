export function resolveCanonicalAccountId(
  accountAliases: Record<string, string> | undefined,
  accountId: string | null | undefined,
): string | null {
  if (!accountId) {
    return null;
  }

  const aliases = accountAliases ?? {};
  const seen = new Set<string>();
  let current = accountId;

  while (current) {
    if (seen.has(current)) {
      return accountId;
    }
    seen.add(current);

    const next = aliases[current];
    if (!next || next === current) {
      return current;
    }
    current = next;
  }

  return accountId;
}

export function buildAccountLookupOrder(
  accountAliases: Record<string, string> | undefined,
  resolvedAccountId: string | null,
  legacyAccountId: string | null,
): string[] {
  const candidates = [
    resolveCanonicalAccountId(accountAliases, resolvedAccountId),
    resolvedAccountId,
    resolveCanonicalAccountId(accountAliases, legacyAccountId),
    legacyAccountId,
  ];

  const ordered: string[] = [];
  for (const candidate of candidates) {
    if (!candidate || ordered.includes(candidate)) {
      continue;
    }
    ordered.push(candidate);
  }

  return ordered;
}

export function collectAliasKeysForCanonical(
  accountAliases: Record<string, string> | undefined,
  canonicalAccountId: string | null,
): string[] {
  if (!canonicalAccountId) {
    return [];
  }

  const aliases = accountAliases ?? {};
  const matches: string[] = [];
  for (const alias of Object.keys(aliases)) {
    if (alias === canonicalAccountId) {
      continue;
    }
    if (resolveCanonicalAccountId(aliases, alias) === canonicalAccountId) {
      matches.push(alias);
    }
  }

  return matches;
}
