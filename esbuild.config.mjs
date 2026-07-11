import { existsSync, watch as watchFs } from 'node:fs';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as esbuild from 'esbuild';

const root = process.cwd();
const outdir = path.join(root, 'dist');
const watchMode = process.argv.includes('--watch');
const promptsDir = path.join(root, 'prompts');
const draftsDir = path.join(promptsDir, 'drafts');

const entryPoints = {
  background: path.join(root, 'src/background/index.ts'),
  content: path.join(root, 'src/content/index.ts'),
  options: path.join(root, 'src/options/index.ts'),
  popup: path.join(root, 'src/popup/index.ts'),
  // E27: the extension-origin viewer for the kernel's assembled prompt.
  'debug-prompt': path.join(root, 'src/debug-prompt/index.ts'),
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
  await cp(path.join(root, 'icons'), path.join(outdir, 'icons'), { recursive: true });
}

async function buildOnce() {
  await rm(outdir, { recursive: true, force: true });
  await mkdir(outdir, { recursive: true });

  await esbuild.build({
    entryPoints,
    outdir,
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['firefox128'],
    sourcemap: true,
    loader: {
      '.md': 'text',
      '.css': 'text',
    },
    define: {
      __CHATGOOSE_BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    },
    plugins: [modelCardDraftsPlugin()],
  });

  await ensureStaticFiles();
}

if (!watchMode) {
  await buildOnce();
} else {
  await buildOnce();
  const ctx = await esbuild.context({
    entryPoints,
    outdir,
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['firefox128'],
    sourcemap: true,
    loader: {
      '.md': 'text',
      '.css': 'text',
    },
    define: {
      __CHATGOOSE_BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    },
    plugins: [
      modelCardDraftsPlugin(),
      {
        name: 'chatgoose-static-copy',
        setup(build) {
          build.onEnd(async () => {
            await ensureStaticFiles();
          });
        },
      },
    ],
  });

  await ctx.watch();
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
  ].filter(({ watchPath }) => existsSync(watchPath));

  const watchers = watchTargets.map(({ watchPath, shouldRebuild }) =>
    watchFs(watchPath, { persistent: true }, async (_eventType, filename) => {
      if (!shouldRebuild(filename)) {
        return;
      }

      try {
        await ctx.rebuild();
      } catch (error) {
        console.error('Failed to rebuild compare drafts module', error);
      }
    }),
  );
  process.on('exit', () => {
    watchers.forEach((watcher) => watcher.close());
  });
  console.log('Watching ChatGoose...');
}
