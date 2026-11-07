import { chat, type Message, type ToolDefinition } from "./ollama.js";

const currentTimeTool: ToolDefinition = {
  type: "function",
  function: {
    name: "get_current_time",
    description: "Get the current UTC date and time from the host machine.",
    parameters: {
      type: "object",
      properties: {},
      required: []
    }
  }
};

const maxToolCalls = 5;

export async function runAgent(prompt: string): Promise<string> {
  const messages: Message[] = [
    {
      role: "system",
      content:
        "Use get_current_time when the user asks for the current date or time. " +
        "Use the tool result as the source for the current UTC time."
    },
    { role: "user", content: prompt }
  ];

  let toolCallsUsed = 0;

  while (true) {
    const tools = toolCallsUsed < maxToolCalls ? [currentTimeTool] : [];
    const reply = await chat(messages, tools);
    const calls = reply.tool_calls ?? [];

    if (calls.length === 0) {
      const answer = reply.content.trim();
      if (!answer) throw new Error("The model returned an empty answer.");
      return answer;
    }

    if (toolCallsUsed + calls.length > maxToolCalls) {
      throw new Error(`Agent reached its limit of ${maxToolCalls} tool calls.`);
    }

    messages.push(reply);

    for (const { function: call } of calls) {
      toolCallsUsed += 1;

      const isValid =
        call.name === currentTimeTool.function.name &&
        Object.keys(call.arguments ?? {}).length === 0;

      if (isValid) {
        console.error("[tool] get_current_time");
      }

      messages.push({
        role: "tool",
        tool_name: call.name,
        content: isValid
          ? JSON.stringify({ utc: new Date().toISOString() })
          : JSON.stringify({ error: "Unknown tool or unexpected arguments." })
      });
    }
  }
}