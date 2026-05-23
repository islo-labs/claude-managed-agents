export const ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com";
export const ANTHROPIC_BETA = "managed-agents-2026-04-01";

export function resolveAnthropicBaseURL(baseUrl?: string): string {
  return baseUrl ?? ANTHROPIC_DEFAULT_BASE_URL;
}

export function bearerAnthropicClient(
  Anthropic: typeof import("@anthropic-ai/sdk").default,
  token: string,
  baseURL?: string,
) {
  return new Anthropic({
    apiKey: null,
    authToken: token,
    baseURL: resolveAnthropicBaseURL(baseURL),
  });
}

export function apiKeyAnthropicClient(
  Anthropic: typeof import("@anthropic-ai/sdk").default,
  apiKey: string,
  baseURL?: string,
) {
  return new Anthropic({
    apiKey,
    baseURL: resolveAnthropicBaseURL(baseURL),
  });
}
