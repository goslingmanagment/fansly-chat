// Dependency-free on purpose: both the classic bootstrap and the lazy vault
// module import this, and neither should drag the constants graph along.

export const VAULT_PATHNAME = '/creator/vault';

export function isVaultPath(pathname: string): boolean {
  return pathname === VAULT_PATHNAME || pathname === `${VAULT_PATHNAME}/`;
}
