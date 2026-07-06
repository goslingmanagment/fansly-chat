// Stage 32 Task 5 — the extension's producer identity on every kernel
// request (kernel Stage 4 / Proposal 4.1: core's capture lane reads
// x-client-version as the producer version; stage-11 §2 anticipates the
// extension producer). Guarded: unit tests run without a browser global.

export function extensionClientVersion(): string {
  try {
    return `chatgoose-extension/${browser.runtime.getManifest().version}`;
  } catch {
    return 'chatgoose-extension/unknown';
  }
}

export function clientVersionHeaders(): Record<string, string> {
  return { 'x-client-version': extensionClientVersion() };
}
