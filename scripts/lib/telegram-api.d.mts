export declare class TelegramApiError extends Error {}
export interface SendRichMessageOptions {
  botToken: string;
  chatId: string;
  markdown: string;
  silent?: boolean;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}
export declare function sendRichMessage(
  options: SendRichMessageOptions,
): Promise<{ message_id: number }>;
