import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { describe, expect, it } from 'vitest';

// The classic bootstrap is the one script EVERY Fansly page parses, for every
// chatter, on every navigation. Its composition is a product contract, not a
// build detail: the vault uploader (E109) once dragged its whole panel copy in
// through the launcher and doubled the script for chatters who never open the
// vault (E111). This bundles the entries the way esbuild.config.mjs does and
// reads the metafile, so the contract fails at `pnpm check` rather than in a
// profiler.

const root = fileURLToPath(new URL('../', import.meta.url));

async function bundleInputs(entry: string, format: 'iife' | 'esm'): Promise<{
  bytes: number;
  inputs: string[];
  text: string;
}> {
  const result = await esbuild.build({
    entryPoints: { entry: path.join(root, entry) },
    bundle: true,
    write: false,
    metafile: true,
    format,
    platform: 'browser',
    target: ['firefox128'],
    minifySyntax: true,
    minifyWhitespace: true,
    charset: 'utf8',
    loader: { '.md': 'text', '.css': 'text' },
    define: { __CHATGOOSE_BUILD_TIME__: '"test"' },
    logLevel: 'silent',
  });
  const [output] = Object.values(result.metafile.outputs);
  return {
    bytes: output?.bytes ?? 0,
    inputs: Object.keys(output?.inputs ?? {}).map((file) => file.replace(/\\/g, '/')),
    text: result.outputFiles?.[0]?.text ?? '',
  };
}

describe('content bootstrap bundle composition', () => {
  it('carries only the launcher of the vault uploader, never the panel or its copy', async () => {
    const { bytes, inputs } = await bundleInputs('src/content/bootstrap.ts', 'iife');

    expect(inputs).toContain('src/content/vault/vault-launcher.ts');
    expect(inputs).toContain('src/content/vault/vault-launcher-copy.ts');
    for (const heavy of [
      'src/content/vault/vault-copy.ts',
      'src/content/vault/vault-panel.ts',
      'src/content/vault/upload-runner.ts',
      'src/content/vault/vault-dom.ts',
      'src/content/vault/checkpoint-store.ts',
      'src/content/vault/vault.css',
      'src/content/vault/index.ts',
      'src/shared/vault-upload.ts',
      'src/content/index.ts',
    ]) {
      expect(inputs, `${heavy} must stay out of the bootstrap`).not.toContain(heavy);
    }
    // Measured 22.3 KB after E111 (19 KB before the vault existed); the
    // ceiling leaves room for ordinary growth, not for another feature's UI.
    expect(bytes).toBeLessThan(28 * 1024);
  });

  it('keeps the lazy vault module free of the conversation app and the settings graph', async () => {
    const { inputs } = await bundleInputs('src/content/vault/index.ts', 'esm');

    expect(inputs).toContain('src/content/vault/vault-panel.ts');
    for (const foreign of [
      'src/content/index.ts',
      'src/content/bootstrap.ts',
      'src/content/route-watcher.ts',
      'src/shared/constants.ts',
      'src/shared/migrations.ts',
    ]) {
      expect(inputs, `${foreign} must stay out of content-vault.js`).not.toContain(foreign);
    }
  });

  it('keeps the E145 page-world socket tap tiny and free of extension APIs and egress', async () => {
    // It runs in Fansly's own world on every page before Fansly's code: parsing
    // and the bridge only — no `browser.*` (there is none there), no request,
    // no write to the socket.
    const { bytes, inputs, text } = await bundleInputs('src/content/page-socket-tap.ts', 'iife');

    expect(inputs.sort()).toEqual([
      'src/content/page-socket-tap.ts',
      'src/shared/fansly-ws-frame.ts',
      'src/shared/message-sound-protocol.ts',
    ]);
    for (const forbidden of ['browser.', 'chrome.', 'fetch(', '.send(', 'XMLHttpRequest']) {
      expect(text, `${forbidden} must stay out of the socket tap`).not.toContain(forbidden);
    }
    // Measured 3.9 KB.
    expect(bytes).toBeLessThan(5 * 1024);
  });

  it('keeps the E145 isolated relay free of zod and the settings graph', async () => {
    const { bytes, inputs } = await bundleInputs('src/content/sound-relay.ts', 'iife');

    expect(inputs.sort()).toEqual([
      'src/content/sound-relay.ts',
      'src/shared/message-sound-protocol.ts',
    ]);
    // Measured 3.2 KB.
    expect(bytes).toBeLessThan(5 * 1024);
  });
});
