import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as esbuild from 'esbuild';

const root = process.cwd();
const outdir = path.join(root, 'dist');
const watch = process.argv.includes('--watch');

const entryPoints = {
  background: path.join(root, 'src/background/index.ts'),
  content: path.join(root, 'src/content/index.ts'),
  options: path.join(root, 'src/options/index.ts'),
  popup: path.join(root, 'src/popup/index.ts'),
};

async function ensureStaticFiles() {
  await mkdir(path.join(outdir, 'icons'), { recursive: true });

  const optionsHtml = await readFile(path.join(root, 'src/options/index.html'), 'utf8');
  const popupHtml = await readFile(path.join(root, 'src/popup/index.html'), 'utf8');
  const manifest = await readFile(path.join(root, 'manifest.json'), 'utf8');

  await writeFile(path.join(outdir, 'options.html'), optionsHtml);
  await writeFile(path.join(outdir, 'popup.html'), popupHtml);
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
      __CHATMUSE_BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    },
  });

  await ensureStaticFiles();
}

if (!watch) {
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
      __CHATMUSE_BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    },
    plugins: [
      {
        name: 'chatmuse-static-copy',
        setup(build) {
          build.onEnd(async () => {
            await ensureStaticFiles();
          });
        },
      },
    ],
  });

  await ctx.watch();
  console.log('Watching ChatMuse...');
}
