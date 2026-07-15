import { describe, expect, it, vi } from 'vitest';
import { sendRichMessage } from '../scripts/lib/telegram-api.mjs';

const TOKEN = '12345:SECRETTOKEN';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const okBody = { ok: true, result: { message_id: 77 } };
const noSleep = () => Promise.resolve();

describe('sendRichMessage', () => {
  it('posts rich markdown once and returns the result', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(okBody));
    const result = await sendRichMessage({
      botToken: TOKEN,
      chatId: '-100123',
      markdown: '# Post',
      fetchImpl,
      sleep: noSleep,
    });
    expect(result.message_id).toBe(77);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0]!;
    const payload = JSON.parse((init as RequestInit).body as string);
    expect(payload).toMatchObject({
      chat_id: '-100123',
      rich_message: { markdown: '# Post', skip_entity_detection: true },
      disable_notification: false,
    });
  });

  it('sets disable_notification for silent sends', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(okBody));
    await sendRichMessage({
      botToken: TOKEN,
      chatId: '-100123',
      markdown: 'x',
      silent: true,
      fetchImpl,
      sleep: noSleep,
    });
    const payload = JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string);
    expect(payload.disable_notification).toBe(true);
  });

  it('fails without retry on a non-429 API error', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ ok: false, error_code: 400, description: 'Bad Request: text is empty' }, 400),
    );
    await expect(
      sendRichMessage({ botToken: TOKEN, chatId: 'c', markdown: 'x', fetchImpl, sleep: noSleep }),
    ).rejects.toThrow(/400.*text is empty/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects an HTTP 2xx whose body says ok:false', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ ok: false, error_code: 400, description: 'Bad Request: odd proxy' }, 200),
    );
    await expect(
      sendRichMessage({ botToken: TOKEN, chatId: 'c', markdown: 'x', fetchImpl, sleep: noSleep }),
    ).rejects.toThrow(/odd proxy/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects a non-2xx even if the body claims ok:true', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(okBody, 500));
    await expect(
      sendRichMessage({ botToken: TOKEN, chatId: 'c', markdown: 'x', fetchImpl, sleep: noSleep }),
    ).rejects.toThrow(/500/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries exactly once after a 429, waiting retry_after seconds', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ ok: false, error_code: 429, parameters: { retry_after: 1 } }, 429),
      )
      .mockResolvedValueOnce(jsonResponse(okBody));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const result = await sendRichMessage({
      botToken: TOKEN,
      chatId: 'c',
      markdown: 'x',
      fetchImpl,
      sleep,
    });
    expect(result.message_id).toBe(77);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1000);
  });

  it('does not retry a 429 that asks to wait more than 60s', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ ok: false, error_code: 429, parameters: { retry_after: 61 } }, 429),
    );
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(
      sendRichMessage({ botToken: TOKEN, chatId: 'c', markdown: 'x', fetchImpl, sleep }),
    ).rejects.toThrow(/61/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('gives up after a second 429', async () => {
    const rateLimited = () =>
      jsonResponse({ ok: false, error_code: 429, parameters: { retry_after: 1 } }, 429);
    const fetchImpl = vi.fn().mockResolvedValueOnce(rateLimited()).mockResolvedValueOnce(rateLimited());
    await expect(
      sendRichMessage({ botToken: TOKEN, chatId: 'c', markdown: 'x', fetchImpl, sleep: noSleep }),
    ).rejects.toThrow(/rate-limited/i);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('treats a pre-response timeout as indeterminate: no retry, check the channel', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValue(new DOMException('The operation timed out', 'TimeoutError'));
    await expect(
      sendRichMessage({ botToken: TOKEN, chatId: 'c', markdown: 'x', fetchImpl, sleep: noSleep }),
    ).rejects.toThrow(/check the channel/i);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('treats a body-read failure on a 2xx as indeterminate too', async () => {
    const brokenBody = {
      ok: true,
      status: 200,
      json: () => Promise.reject(new DOMException('body timeout', 'TimeoutError')),
    } as unknown as Response;
    const fetchImpl = vi.fn().mockResolvedValue(brokenBody);
    await expect(
      sendRichMessage({ botToken: TOKEN, chatId: 'c', markdown: 'x', fetchImpl, sleep: noSleep }),
    ).rejects.toThrow(/check the channel/i);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('redacts the bot token from network error messages', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValue(new TypeError(`fetch failed: https://api.telegram.org/bot${TOKEN}/x`));
    const rejection = sendRichMessage({
      botToken: TOKEN,
      chatId: 'c',
      markdown: 'x',
      fetchImpl,
      sleep: noSleep,
    });
    await expect(rejection).rejects.toThrow();
    await rejection.catch((error: Error) => {
      expect(error.message).not.toContain('SECRETTOKEN');
    });
  });

  it('surfaces a non-JSON non-2xx body with its HTTP status', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('<html>bad gateway</html>', { status: 502 }));
    await expect(
      sendRichMessage({ botToken: TOKEN, chatId: 'c', markdown: 'x', fetchImpl, sleep: noSleep }),
    ).rejects.toThrow(/502/);
  });
});
