export type Message = {
  role: "user" | "assistant";
  content: string;
};

const model = process.env.OLLAMA_MODEL?.trim() || "qwen3.5:4b";

export async function chat(messages: Message[]): Promise<Message> {
  const response = await fetch("http://localhost:11434/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, stream: false }),
    signal: AbortSignal.timeout(120_000)
  });

  if (!response.ok) {
    throw new Error(`Ollama returned HTTP ${response.status}: ${await response.text()}`);
  }

  const result = (await response.json()) as { message: Message };
  return result.message;
}