type ToolCall = {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
};

export type Message =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; tool_calls?: ToolCall[] }
  | { role: "tool"; content: string; tool_name: string };

export type ToolDefinition = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required: string[];
    };
  };
};

const model = process.env.OLLAMA_MODEL?.trim() || "qwen3:1.7b";

export async function chat(
  messages: Message[],
  tools: ToolDefinition[] = []
): Promise<Extract<Message, { role: "assistant" }>> {
  const response = await fetch("http://localhost:11434/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, tools, stream: false }),
    signal: AbortSignal.timeout(180_000)
  });

  if (!response.ok) {
    throw new Error(`Ollama returned HTTP ${response.status}: ${await response.text()}`);
  }

    const result = (await response.json()) as {
        message: Extract<Message, { role: "assistant" }>;
    };
    return result.message;
}