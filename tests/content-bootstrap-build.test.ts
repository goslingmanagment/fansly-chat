import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import manifest from '../manifest.json';

const root = new URL('../', import.meta.url);
const readRepoFile = (path: string): string =>
  readFileSync(new URL(path, root), 'utf8');

describe('two-stage content bootstrap build contract', () => {
  it('injects the lightweight classic bootstrap and the two early sound scripts only', () => {
    // E145: the MAIN-world socket tap must be in place before Fansly's own code
    // opens its socket, and its isolated relay must listen from the same moment.
    // Everything else still waits for the document_idle bootstrap.
    expect(manifest.content_scripts).toHaveLength(3);
    expect(manifest.content_scripts[0]).toEqual({
      matches: ['*://fansly.com/*'],
      js: ['content-socket-tap.js'],
      run_at: 'document_start',
      world: 'MAIN',
    });
    expect(manifest.content_scripts[1]).toEqual({
      matches: ['*://fansly.com/*'],
      js: ['content-sound-relay.js'],
      run_at: 'document_start',
    });
    expect(manifest.content_scripts[2]).toMatchObject({
      matches: ['*://fansly.com/*'],
      js: ['content.js'],
      run_at: 'document_idle',
    });
    expect(
      manifest.content_scripts.flatMap((entry) => entry.js),
    ).toEqual(['content-socket-tap.js', 'content-sound-relay.js', 'content.js']);
    expect(
      manifest.content_scripts.flatMap((entry) => 'css' in entry ? entry.css : []),
    ).toEqual([]);
  });

  it('exposes the lazy application module and stylesheet only to Fansly pages', () => {
    const lazyAssets = manifest.web_accessible_resources.find((entry) =>
      entry.resources.includes('content-chat.js') &&
      entry.resources.includes('content-vault.js') &&
      entry.resources.includes('content.css') &&
      entry.resources.includes('vault.css'));

    expect(lazyAssets).toBeDefined();
    expect(lazyAssets?.matches).toEqual(['*://fansly.com/*']);
  });

  it('builds the bootstrap and lazy application as distinct output entries', () => {
    const build = readRepoFile('esbuild.config.mjs');
    const bootstrap = readRepoFile('src/content/bootstrap.ts');

    // Entry-point object keys are esbuild's output basenames. Pin source→output
    // wiring without reading a potentially stale or absent dist directory.
    expect(build).toMatch(
      /const contentBootstrapEntryPoints = \{\s*content: path\.join\(root, 'src\/content\/bootstrap\.ts'\),?\s*\};/,
    );
    expect(build).toMatch(
      /const contentAppEntryPoints = \{\s*'content-followers': path\.join\(root, 'src\/content\/followers\/index\.ts'\),\s*'content-chat': path\.join\(root, 'src\/content\/index\.ts'\),\s*(?:\/\/[^\n]*\n\s*)*'content-vault': path\.join\(root, 'src\/content\/vault\/index\.ts'\),?\s*\};/,
    );
    expect(build).toMatch(
      /entryPoints: contentBootstrapEntryPoints,\s*format: 'iife'/,
    );
    expect(build).toMatch(
      /const contentEarlyEntryPoints = \{[^}]*'content-socket-tap': path\.join\(root, 'src\/content\/page-socket-tap\.ts'\),\s*'content-sound-relay': path\.join\(root, 'src\/content\/sound-relay\.ts'\),?\s*\};/,
    );
    // Both the one-shot build and the watch contexts carry the early scripts.
    expect(build.match(/entryPoints: contentEarlyEntryPoints,\s*format: 'iife'/g)).toHaveLength(2);
    expect(build).toMatch(
      /entryPoints: contentAppEntryPoints,\s*format: 'esm'/,
    );
    expect(build).toMatch(
      /cp\(path\.join\(root, 'src\/content\/styles\.css'\), path\.join\(outdir, 'content\.css'\)\)/,
    );
    expect(build).toMatch(
      /cp\(path\.join\(root, 'src\/content\/vault\/vault\.css'\), path\.join\(outdir, 'vault\.css'\)\)/,
    );
    expect(bootstrap).toContain("browser.runtime.getURL('content-chat.js')");
    expect(bootstrap).toContain("browser.runtime.getURL('content-vault.js')");
    // Both sheets go through one fetch-and-install helper keyed by file name.
    expect(bootstrap).toContain("ensureStylesheet('content.css', 'chatgoose-style'");
    expect(bootstrap).toContain("ensureStylesheet('vault.css', 'chatgoose-vault-style'");
    expect(bootstrap).toContain('`${baseModuleUrl}?retry=${attempt}`');
    expect(build.match(/minifySyntax: true/g)).toHaveLength(2);
    expect(build.match(/minifyWhitespace: true/g)).toHaveLength(2);
  });

  it('keeps the lightweight lifecycle port outside operational port handling', () => {
    const bootstrap = readRepoFile('src/content/bootstrap.ts');
    const keepalive = readRepoFile('src/content/bootstrap-keepalive.ts');
    const background = readRepoFile('src/background/index.ts');
    const keepaliveBranch = background.indexOf(
      "if (port.name === 'chatgoose-bootstrap')",
    );
    const operationalRegistration = background.indexOf(
      'coordinator.registerPort(port)',
    );

    expect(keepalive).toContain("name: 'chatgoose-bootstrap'");
    expect(keepalive).toContain('scheduleReconnect()');
    expect(bootstrap).toContain('bootstrapKeepalive.handOff()');
    expect(keepaliveBranch).toBeGreaterThanOrEqual(0);
    expect(operationalRegistration).toBeGreaterThan(keepaliveBranch);
    expect(background.slice(keepaliveBranch, operationalRegistration))
      .toContain('return;');
  });
});
