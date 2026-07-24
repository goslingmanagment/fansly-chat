declare const __CHATGOOSE_BUILD_TIME__: string;

declare module '*.md' {
  const value: string;
  export default value;
}

declare module '*.css' {
  const value: string;
  export default value;
}

declare module 'node:fs' {
  interface Dirent {
    name: string;
    isDirectory(): boolean;
    isFile(): boolean;
  }

  export function readFileSync(
    path: string | URL,
    encoding: string,
  ): string;
  // Byte read — the local-fonts test checks the WOFF2 magic of each bundled
  // file without decoding it as text.
  export function readFileSync(path: string | URL): Uint8Array;
  export function readdirSync(
    path: string | URL,
    options: { withFileTypes: true },
  ): Dirent[];
}
