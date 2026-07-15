#!/usr/bin/env node
// Posts a CHANGELOG.md section to the ChatGoose Telegram channel via Bot API
// sendRichMessage. --check validates extraction, the markdown subset, and
// limits without credentials or network — deploy.sh runs it in preflight,
// before the irreversible AMO request.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { composePost, extractSection, validatePost } from './lib/announce-post.mjs';
import { sendRichMessage } from './lib/telegram-api.mjs';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fail(message) {
  console.error(`[announce] ${message}`);
  process.exit(1);
}

let values;
try {
  ({ values } = parseArgs({
    options: {
      version: { type: 'string' },
      check: { type: 'boolean', default: false },
      silent: { type: 'boolean', default: false },
    },
  }));
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

const manifestVersion = JSON.parse(
  readFileSync(path.join(ROOT_DIR, 'manifest.json'), 'utf8'),
).version;
const version = values.version ?? manifestVersion;

let post;
try {
  const changelog = readFileSync(path.join(ROOT_DIR, 'CHANGELOG.md'), 'utf8');
  post = validatePost(composePost(extractSection(changelog, version)));
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

if (values.check) {
  console.log(`[announce] check ok: v${version}, ${[...post].length} chars`);
  process.exit(0);
}

try {
  process.loadEnvFile(path.join(ROOT_DIR, '.env.deploy'));
} catch {
  fail('Could not read .env.deploy — it must exist next to package.json');
}
const botToken = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHANNEL_ID;
if (!botToken || !chatId) {
  fail('TELEGRAM_BOT_TOKEN and TELEGRAM_CHANNEL_ID must be set in .env.deploy');
}

try {
  const result = await sendRichMessage({
    botToken,
    chatId,
    markdown: post,
    silent: values.silent,
  });
  console.log(`[announce] posted v${version} (message_id ${result.message_id})`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
