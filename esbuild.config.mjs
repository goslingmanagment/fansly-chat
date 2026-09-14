import { existsSync, watch as watchFs } from 'node:fs';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as esbuild from 'esbuild';

const root = process.cwd();
const outdir = path.join(root, 'dist');
const watchMode = process.argv.includes('--watch');
const promptsDir = path.join(root, 'prompts');
const draftsDir = path.join(promptsDir, 'drafts');

const pageEntryPoints = {
  background: path.join(root, 'src/background/index.ts'),
  options: path.join(root, 'src/options/index.ts'),
  popup: path.join(root, 'src/popup/index.ts'),
  // E28: the extension-origin viewer for the kernel's assembled prompt.
  'debug-prompt': path.join(root, 'src/debug-prompt/index.ts'),
};
const contentBootstrapEntryPoints = {
  content: path.join(root, 'src/content/bootstrap.ts'),
};
const contentAppEntryPoints = {
  'content-followers': path.join(root, 'src/content/followers/index.ts'),
  'content-chat': path.join(root, 'src/content/index.ts'),
  // E109: the vault uploader is its own lazy ESM — loaded from the launcher on
  // /creator/vault, never bundled into the conversation app.
  'content-vault': path.join(root, 'src/content/vault/index.ts'),
};

function compareDraftNames(left, right) {
  return left.localeCompare(right, 'en', {
    sensitivity: 'base',
    numeric: true,
  });
}

function modelCardDraftsPlugin() {
  return /** @type {esbuild.Plugin} */ ({
    name: 'chatgoose-virtual-drafts',
    setup(build) {
      build.onResolve({ filter: /^virtual:model-card-drafts$/ }, () => ({
        path: 'virtual:model-card-drafts',
        namespace: 'chatgoose-virtual-drafts',
      }));

      build.onLoad(
        { filter: /.*/, namespace: 'chatgoose-virtual-drafts' },
        async () => {
          let files;
          try {
            files = (await readdir(draftsDir))
              .filter((filename) => filename.toLowerCase().endsWith('.md'))
              .sort(compareDraftNames);
          } catch {
            files = [];
          }

          const imports = files.map(
            (filename, index) =>
              `import draft${index} from ${JSON.stringify(path.join(draftsDir, filename))};`,
          );
          const entries = files.map(
            (filename, index) =>
              `${JSON.stringify(filename.replace(/\.md$/i, ''))}: draft${index}`,
          );

          return {
            contents: `${imports.join('\n')}\nexport default { ${entries.join(', ')} };\n`,
            resolveDir: root,
            loader: 'ts',
          };
        },
      );
    },
  });
}

async function ensureStaticFiles() {
  await mkdir(path.join(outdir, 'icons'), { recursive: true });

  const optionsHtml = await readFile(path.join(root, 'src/options/index.html'), 'utf8');
  const popupHtml = await readFile(path.join(root, 'src/popup/index.html'), 'utf8');
  const debugPromptHtml = await readFile(path.join(root, 'src/debug-prompt/index.html'), 'utf8');
  const manifest = await readFile(path.join(root, 'manifest.json'), 'utf8');

  await writeFile(path.join(outdir, 'options.html'), optionsHtml);
  await writeFile(path.join(outdir, 'popup.html'), popupHtml);
  await writeFile(path.join(outdir, 'debug-prompt.html'), debugPromptHtml);
  await writeFile(path.join(outdir, 'manifest.json'), manifest);
  await cp(path.join(root, 'src/options/styles.css'), path.join(outdir, 'options.css'));
  await cp(path.join(root, 'src/popup/styles.css'), path.join(outdir, 'popup.css'));
  await cp(path.join(root, 'src/debug-prompt/styles.css'), path.join(outdir, 'debug-prompt.css'));
  await cp(path.join(root, 'src/content/styles.css'), path.join(outdir, 'content.css'));
  // E111: the vault panel's sheet ships apart from content.css and is fetched
  // only when the launcher is pressed.
  await cp(path.join(root, 'src/content/vault/vault.css'), path.join(outdir, 'vault.css'));
  await cp(path.join(root, 'icons'), path.join(outdir, 'icons'), { recursive: true });
  // Family fonts ride along instead of a Google Fonts CDN request: the
  // `@font-face` rules in options/popup styles resolve `url('fonts/…')`
  // against this directory.
  await cp(path.join(root, 'assets/fonts'), path.join(outdir, 'fonts'), { recursive: true });
}

async function buildOnce() {
  await rm(outdir, { recursive: true, force: true });
  await mkdir(outdir, { recursive: true });

  const define = {
    __CHATGOOSE_BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  };
  const common = {
    outdir,
    bundle: true,
    platform: 'browser',
    target: ['firefox128'],
    sourcemap: true,
    // Production-safe minification without identifier mangling: less source for
    // Firefox to parse while function/class names remain readable in mapped
    // stacks. The same shape is used in watch builds so debug and release do not
    // execute materially different JavaScript.
    minifySyntax: true,
    minifyWhitespace: true,
    // Emit UTF-8 literals instead of `\uXXXX` escapes: the Russian copy in
    // every bundle is a third smaller to fetch and parse, and Firefox decodes
    // extension scripts (manifest, dynamic import, page <meta charset>) as
    // UTF-8 regardless.
    charset: 'utf8',
    loader: {
      '.md': 'text',
      '.css': 'text',
    },
    define,
    plugins: [modelCardDraftsPlugin()],
  };

  await Promise.all([
    esbuild.build({
      ...common,
      entryPoints: pageEntryPoints,
      format: 'iife',
    }),
    esbuild.build({
      ...common,
      entryPoints: contentBootstrapEntryPoints,
      format: 'iife',
    }),
    // Firefox content scripts support dynamic import of moz-extension: URLs.
    // The bootstrap remains a classic manifest script; this self-contained ESM
    // is parsed only when a message route or a global ChatGoose action needs it.
    esbuild.build({
      ...common,
      entryPoints: contentAppEntryPoints,
      format: 'esm',
    }),
  ]);

  await ensureStaticFiles();
}

if (!watchMode) {
  await buildOnce();
} else {
  await buildOnce();
  const define = {
    __CHATGOOSE_BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  };
  const staticCopyPlugin = {
    name: 'chatgoose-static-copy',
    setup(build) {
      build.onEnd(async () => {
        await ensureStaticFiles();
      });
    },
  };
  const common = {
    outdir,
    bundle: true,
    platform: 'browser',
    target: ['firefox128'],
    sourcemap: true,
    minifySyntax: true,
    minifyWhitespace: true,
    charset: 'utf8',
    loader: {
      '.md': 'text',
      '.css': 'text',
    },
    define,
  };
  const contexts = await Promise.all([
    esbuild.context({
      ...common,
      entryPoints: pageEntryPoints,
      format: 'iife',
      plugins: [modelCardDraftsPlugin(), staticCopyPlugin],
    }),
    esbuild.context({
      ...common,
      entryPoints: contentBootstrapEntryPoints,
      format: 'iife',
      plugins: [modelCardDraftsPlugin()],
    }),
    esbuild.context({
      ...common,
      entryPoints: contentAppEntryPoints,
      format: 'esm',
      plugins: [modelCardDraftsPlugin()],
    }),
  ]);

  await Promise.all(contexts.map((context) => context.watch()));
  const watchTargets = [
    {
      watchPath: promptsDir,
      shouldRebuild(filename) {
        return filename === 'drafts';
      },
    },
    {
      watchPath: draftsDir,
      shouldRebuild(filename) {
        return typeof filename !== 'string' || filename.toLowerCase().endsWith('.md');
      },
    },
    ...[
      'src/options/styles.css',
      'src/popup/styles.css',
      'src/debug-prompt/styles.css',
      'src/content/styles.css',
      'src/content/vault/vault.css',
    ].map((relativePath) => ({
      watchPath: path.join(root, relativePath),
      shouldRebuild() {
        return true;
      },
    })),
  ].filter(({ watchPath }) => existsSync(watchPath));

  const watchers = watchTargets.map(({ watchPath, shouldRebuild }) =>
    watchFs(watchPath, { persistent: true }, async (_eventType, filename) => {
      if (!shouldRebuild(filename)) {
        return;
      }

      try {
        await Promise.all(contexts.map((context) => context.rebuild()));
      } catch (error) {
        console.error('Failed to rebuild compare drafts module', error);
      }
    }),
  );
  process.on('exit', () => {
    watchers.forEach((watcher) => watcher.close());
    contexts.forEach((context) => {
      void context.dispose();
    });
  });
  console.log('Watching ChatGoose...');
}
