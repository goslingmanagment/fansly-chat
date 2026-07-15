export declare const RICH_MESSAGE_CHAR_LIMIT: number;
export declare function extractSection(
  changelogText: string,
  version: string,
): { heading: string; body: string };
export declare function composePost(section: { heading: string; body: string }): string;
export declare function validatePost(post: string): string;
