import Anthropic from "@anthropic-ai/sdk";

export const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-5";

let client: Anthropic | null = null;

/** Restituisce (e memorizza) il client Anthropic, leggendo la API key dall'env. */
export function getAnthropic(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY non impostata. Copia .env.example in .env.local e inserisci la tua API key."
    );
  }
  if (!client) {
    client = new Anthropic({ apiKey });
  }
  return client;
}

export function isApiKeyConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/**
 * Helper generico: invia un prompt a Claude e restituisce il testo della risposta.
 * `system` opzionale per le istruzioni di sistema.
 */
export async function askClaude(params: {
  prompt: string;
  system?: string;
  model?: string;
  maxTokens?: number;
}): Promise<string> {
  const anthropic = getAnthropic();
  const msg = await anthropic.messages.create({
    model: params.model || DEFAULT_MODEL,
    max_tokens: params.maxTokens ?? 4096,
    system: params.system,
    messages: [{ role: "user", content: params.prompt }],
  });
  return msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}
