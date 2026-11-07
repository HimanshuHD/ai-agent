type ToolCall = {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
};

export type Message
  = | { role: "system" | "user"; content: string }
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

type AssistantMessage = Extract<Message, { role: "assistant" }>;

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseChatResponse(value: unknown): AssistantMessage {
  const fail = (detail: string): never => {
    throw new Error(`Malformed Ollama response: ${detail}`);
  };
  if (!isObject(value) || !isObject(value.message)) {
    return fail("expected an object containing an assistant message.");
  }
  const message = value.message;
  if (message.role !== "assistant" || typeof message.content !== "string") {
    return fail("message must have assistant role and string content.");
  }
  const result: AssistantMessage = { role: "assistant", content: message.content };
  if (message.tool_calls !== undefined) {
    if (!Array.isArray(message.tool_calls)) {
      return fail("message.tool_calls must be an array.");
    }
    result.tool_calls = message.tool_calls.map((call: unknown, index: number) => {
      if (!isObject(call) || !isObject(call.function)
        || typeof call.function.name !== "string" || !call.function.name.trim()
        || !isObject(call.function.arguments)) {
        return fail(`tool_calls[${index}] must contain a nonempty function name and an argument object.`);
      }
      return {
        function: { name: call.function.name, arguments: call.function.arguments },
      };
    });
  }
  return result;
}

const model = process.env.OLLAMA_MODEL?.trim() || "qwen3:1.7b";

export async function chat(
  messages: Message[],
  tools: ToolDefinition[] = [],
): Promise<Extract<Message, { role: "assistant" }>> {
  let response: Response;
  try {
    response = await fetch("http://localhost:11434/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages, tools, stream: false }),
      signal: AbortSignal.timeout(180_000),
    });
  }
  catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new Error("Ollama request timed out after 180 seconds.", { cause: error });
    }
    throw new Error("Could not connect to Ollama at http://localhost:11434. Check that Ollama is running.", { cause: error });
  }

  if (!response.ok) {
    throw new Error(`Ollama returned HTTP ${response.status}: ${await response.text()}`);
  }

  let result: unknown;
  try {
    result = await response.json();
  }
  catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new Error("Ollama request timed out after 180 seconds.", { cause: error });
    }
    throw new Error("Malformed Ollama response: could not read response JSON.", { cause: error });
  }
  return parseChatResponse(result);
}
