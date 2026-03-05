import { ANTHROPIC_VERSION, CLAUDE_API_URL, MAX_TOKENS } from '../shared/constants.js';
import { ChatMuseError } from '../shared/errors.js';
import type { FeatureType } from '../shared/types.js';

interface StreamArgs {
  apiKey: string;
  model: string;
  system: string;
  user: string;
  feature: FeatureType;
  signal: AbortSignal;
  onText: (text: string) => void;
}

function parseSseBlock(block: string): { event: string; data: string } | null {
  const lines = block.split('\n').map((line) => line.trim());
  let event = 'message';
  const dataLines: string[] = [];

  for (const line of lines) {
    if (!line) {
      continue;
    }
    if (line.startsWith('event:')) {
      event = line.slice('event:'.length).trim();
      continue;
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trim());
    }
  }

  if (dataLines.length === 0) {
    return null;
  }

  return { event, data: dataLines.join('\n') };
}

export class AnthropicClient {
  async streamMessage({ apiKey, model, system, user, feature, signal, onText }: StreamArgs): Promise<string> {
    let rawText = '';
    const response = await fetch(CLAUDE_API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      signal,
      body: JSON.stringify({
        model,
        stream: true,
        max_tokens: MAX_TOKENS[feature],
        system,
        messages: [{ role: 'user', content: user }],
      }),
    });

    if (response.status === 401 || response.status === 403) {
      throw new ChatMuseError('invalid_api_key');
    }
    if (response.status === 429 || response.status >= 500) {
      throw new ChatMuseError('claude_overloaded');
    }
    if (response.status === 400) {
      try {
        const body = await response.json() as { error?: { type?: string; message?: string } };
        const errType = body?.error?.type ?? '';
        const errMsg = body?.error?.message?.toLowerCase() ?? '';
        if (
          errType === 'not_found_error' ||
          errMsg.includes('not found') ||
          errMsg.includes('does not exist') ||
          errMsg.includes('deprecated')
        ) {
          throw new ChatMuseError('model_unavailable');
        }
      } catch (e) {
        if (e instanceof ChatMuseError) throw e;
      }
      throw new ChatMuseError('unknown_error');
    }
    if (!response.ok || !response.body) {
      throw new ChatMuseError('network_error');
    }

    const decoder = new TextDecoder();
    let buffer = '';
    const reader = response.body.getReader();

    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });

      const blocks = buffer.split('\n\n');
      buffer = blocks.pop() ?? '';

      for (const block of blocks) {
        const parsed = parseSseBlock(block);
        if (!parsed || parsed.data === '[DONE]') {
          continue;
        }

        // Protect against malformed SSE data
        let payload: {
          type?: string;
          delta?: { type?: string; text?: string };
          error?: { type?: string };
        };
        try {
          payload = JSON.parse(parsed.data) as typeof payload;
        } catch {
          continue;
        }

        if (parsed.event === 'error' || payload.type === 'error') {
          throw new ChatMuseError('claude_overloaded');
        }

        if (
          parsed.event === 'content_block_delta' &&
          payload.delta?.type === 'text_delta' &&
          payload.delta.text
        ) {
          rawText += payload.delta.text;
          onText(payload.delta.text);
        }
      }

      if (done) {
        break;
      }
    }

    return rawText;
  }
}
