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
  export function readFileSync(
    path: string | URL,
    encoding: string,
  ): string;
}
