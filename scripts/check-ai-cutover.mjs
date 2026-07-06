#!/usr/bin/env node
// Stage 32 Task 3 — grep gates: the AI cutover is structural. Wired into
// `pnpm check` (the pre-Stage-19-core ratchet-script pattern; the repo's
// tsconfig is browser-pure, so this lives outside vitest).

import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function grepSrc(pattern) {
  try {
    return execFileSync('grep', ['-rlE', pattern, '--include=*.ts', 'src'], {
      cwd: root,
      encoding: 'utf8',
    }).trim();
  } catch {
    return '';
  }
}

const failures = [];

const vendorEndpoints = grepSrc('api\\.anthropic\\.com|openrouter\\.ai');
if (vendorEndpoints) {
  failures.push(`vendor endpoints referenced:\n${vendorEndpoints}`);
}

const deadImports = grepSrc(
  "from '.*(llm-client|anthropic-client|openrouter-client|llm-cost|llm-stream-utils|model-registry|model-capabilities|feature-readiness|agency-hub-usage-reporter|shared/prompts)\\.js'",
);
if (deadImports) {
  failures.push(`deleted-module imports:\n${deadImports}`);
}

if (failures.length > 0) {
  console.error(`AI cutover gates FAILED:\n${failures.join('\n')}`);
  process.exit(1);
}
console.log('AI cutover gates: clean (no vendor endpoints, no deleted-module imports).');
