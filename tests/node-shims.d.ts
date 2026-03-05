declare module 'node:os' {
  interface OsModule {
    tmpdir(): string;
  }

  const os: OsModule;
  export default os;
}

declare module 'node:path' {
  interface PathModule {
    join(...paths: string[]): string;
  }

  const path: PathModule;
  export default path;
}

declare module 'node:fs/promises' {
  export function mkdtemp(prefix: string): Promise<string>;
  export function mkdir(
    path: string,
    options?: { recursive?: boolean },
  ): Promise<void>;
  export function rm(
    path: string,
    options?: { recursive?: boolean; force?: boolean },
  ): Promise<void>;
  export function writeFile(path: string, data: string): Promise<void>;
}
