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
    dirname(path: string): string;
    resolve(...paths: string[]): string;
  }

  const path: PathModule;
  export default path;
}

declare module 'node:child_process' {
  export function execFileSync(
    file: string,
    args?: string[],
    options?: { cwd?: string; encoding?: string },
  ): string;
  export function spawnSync(
    file: string,
    args: string[],
    options: { cwd?: string; encoding: 'utf8'; env?: Record<string, string> },
  ): { status: number | null; signal: string | null; stdout: string; stderr: string };
}

declare module 'node:url' {
  export function fileURLToPath(url: string | URL): string;
}

declare const process: {
  execPath: string;
};

declare module 'node:fs' {
  export function writeFileSync(path: string | URL, data: string): void;
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

declare module 'node:crypto' {
  interface Hash {
    update(data: string | Uint8Array): Hash;
    digest(encoding: 'hex'): string;
  }
  export function createHash(algorithm: 'sha256'): Hash;
}
