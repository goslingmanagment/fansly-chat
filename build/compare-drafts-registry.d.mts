export interface CompareDraftFileEntry {
  filename: string;
  label: string;
  absolutePath: string;
}

export function listCompareDraftFiles(
  rootDir: string,
): Promise<CompareDraftFileEntry[]>;

export function buildCompareDraftRegistrySource(
  rootDir: string,
): Promise<string>;

export function writeCompareDraftRegistry(rootDir: string): Promise<void>;

export function ensureCompareDraftRegistry(rootDir: string): Promise<void>;
