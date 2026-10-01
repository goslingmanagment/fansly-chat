#!/usr/bin/env node
// Stage 32 Task 3 — grep gates: the AI cutover is structural. Wired into
// `pnpm check` (the pre-Stage-19-core ratchet-script pattern; the repo's
// tsconfig is browser-pure, so this lives outside vitest).

import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// The matching lines of `grep args`, '' when no line matched. grep exits 0
// when a line matched, 1 when none did, and 2 on an error (a missing or
// unreadable file, a bad pattern) even when other files matched. Only 1 reads
// as "nothing found": an error, a signal or a grep that never started throws,
// or one missing page would hide a hit in every other file.
function grep(args, over) {
  try {
    return execFileSync('grep', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    if (error.status === 1) return '';
    const outcome =
      typeof error.status === 'number'
        ? `exit ${error.status}`
        : error.signal
          ? `killed by ${error.signal}`
          : error.code === 'ENOENT'
            ? 'grep not found'
            : error.message;
    const said = [error.stderr, error.stdout]
      .map((text) => (typeof text === 'string' ? text.trim() : ''))
      .filter(Boolean)
      .join('\n');
    throw new Error(`grep over ${over} did not finish its search (${outcome})${said ? `:\n${said}` : ''}`);
  }
}

const grepSrc = (pattern) => grep(['-rlE', pattern, '--include=*.ts', 'src'], 'src/**/*.ts');

const USER_DOCS = ['README.md', 'guide.html', 'start.html'];
const grepUserDocs = (pattern) => grep(['-nE', pattern, ...USER_DOCS], USER_DOCS.join(', '));

const failures = [];

try {
  const vendorEndpoints = grepSrc('api\\.anthropic\\.com|openrouter\\.ai');
  if (vendorEndpoints) {
    failures.push(`vendor endpoints referenced:\n${vendorEndpoints}`);
  }

  const staleUserDocs = grepUserDocs(
    // bare "Claude" ловит и Claude Direct / Claude API Key: в kernel-only
    // user-доках модель выбирает сервер, provider-имена в них запрещены целиком.
    // E123: чаттеру вообще не выдают никаких учётных данных — «введите …-ключ» в
    // любом виде теперь ложь, а не только про vendor-ключи. Словарь §2 целиком
    // пинится тестом tests/copy-vocabulary.test.ts; здесь остаётся AI-половина.
    'api\\.anthropic\\.com|openrouter\\.ai|console\\.anthropic\\.com|Введите [^ ]*-?ключ|OpenRouter API Key|Claude',
  );
  if (staleUserDocs) {
    failures.push(`pre-kernel instructions in shipped user docs:\n${staleUserDocs}`);
  }

  const deadImports = grepSrc(
    "from '.*(llm-client|anthropic-client|openrouter-client|llm-cost|llm-stream-utils|model-registry|model-capabilities|feature-readiness|agency-hub-usage-reporter|shared/prompts)\\.js'",
  );
  if (deadImports) {
    failures.push(`deleted-module imports:\n${deadImports}`);
  }
} catch (error) {
  failures.push(error.message);
}

if (failures.length > 0) {
  console.error(`AI cutover gates FAILED:\n${failures.join('\n')}`);
  process.exit(1);
}
console.log('AI cutover gates: clean (source and shipped user docs match kernel-only AI).');
