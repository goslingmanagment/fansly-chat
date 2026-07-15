// Telegram Bot API adapter for release announcements. The bot token is part
// of the request URL — no URL or raw fetch error may ever reach output
// unredacted. Family law: an indeterminate send is never retried — and ANY
// transport failure after the request is dispatched is indeterminate,
// including a body-read failure on a 2xx response. Only an explicit 429
// with retry_after ≤ 60s gets exactly one retry.

const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_AFTER_MAX_SECONDS = 60;

export class TelegramApiError extends Error {}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function redact(text, secret) {
  return text.split(secret).join('<bot-token>');
}

function indeterminateError(error, botToken) {
  const name = error instanceof Error ? error.name : '';
  const detail =
    name === 'TimeoutError' || name === 'AbortError'
      ? 'request timed out'
      : redact(error instanceof Error ? error.message : String(error), botToken);
  return new TelegramApiError(
    `Transport failure (${detail}) — the send is indeterminate (Telegram may have accepted it); check the channel before retrying`,
  );
}

async function callTelegram({ botToken, method, payload, fetchImpl }) {
  let response;
  try {
    response = await fetchImpl(`https://api.telegram.org/bot${botToken}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw indeterminateError(error, botToken);
  }
  let json = null;
  try {
    json = await response.json();
  } catch (error) {
    // Headers arrived but the body could not be read. On a 2xx Telegram may
    // well have accepted the post — indeterminate. On an error status the
    // send failed; surface the status instead.
    if (response.ok) {
      throw indeterminateError(error, botToken);
    }
  }
  if (response.ok && json?.ok === true) {
    return { kind: 'ok', result: json.result };
  }
  if (response.status === 429 || json?.error_code === 429) {
    return { kind: 'rate_limited', retryAfterSeconds: json?.parameters?.retry_after ?? 5 };
  }
  const description = json?.description ?? `HTTP ${response.status} with an unreadable body`;
  return {
    kind: 'failed',
    message: `Telegram error ${json?.error_code ?? response.status}: ${redact(String(description), botToken)}`,
  };
}

export async function sendRichMessage({
  botToken,
  chatId,
  markdown,
  silent = false,
  fetchImpl = fetch,
  sleep = defaultSleep,
}) {
  const payload = {
    chat_id: chatId,
    rich_message: { markdown, skip_entity_detection: true },
    disable_notification: silent,
  };
  let attempt = await callTelegram({ botToken, method: 'sendRichMessage', payload, fetchImpl });
  if (attempt.kind === 'rate_limited') {
    if (attempt.retryAfterSeconds > RETRY_AFTER_MAX_SECONDS) {
      throw new TelegramApiError(
        `Rate-limited: Telegram asks to wait ${attempt.retryAfterSeconds}s — not retrying automatically, rerun later`,
      );
    }
    await sleep(attempt.retryAfterSeconds * 1000);
    attempt = await callTelegram({ botToken, method: 'sendRichMessage', payload, fetchImpl });
  }
  if (attempt.kind === 'ok') {
    return attempt.result;
  }
  if (attempt.kind === 'rate_limited') {
    throw new TelegramApiError('Still rate-limited after one retry — try again later');
  }
  throw new TelegramApiError(attempt.message);
}
