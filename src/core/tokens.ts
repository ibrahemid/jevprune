export const CHARS_PER_TOKEN = 3;
export const DEFAULT_WINDOW_TOKENS = 25_000;
export const MAX_REQUEST_TOKENS = 32_000;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function estimateJsonTokens(value: unknown): number {
  return estimateTokens(JSON.stringify(value) ?? "");
}
