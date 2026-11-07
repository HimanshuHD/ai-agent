import { chat, type Message, type ToolDefinition } from "./ollama.js";
import { listFiles, type Workspace } from "./workspace.js";

const currentTimeTool: ToolDefinition = {
  type: "function",
  function: {
    name: "get_current_time",
    description: "Get the current UTC date and time from the host machine.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
};

const listFilesTool: ToolDefinition = {
  type: "function",
  function: {
    name: "list_files",
    description: "List allowed files in the selected workspace. Results are bounded and may be incomplete.",
    parameters: {
      type: "object",
      properties: { directory: { type: "string", description: "Optional workspace-relative directory; defaults to the root." } },
      required: [],
    },
  },
};

const maxToolCalls = 5;

export async function runAgent(prompt: string, workspace?: Workspace): Promise<string> {
  const messages: Message[] = [
    {
      role: "system",
      content:
        "Use get_current_time when the user asks for the current date or time. "
        + "Use the tool result as the source for the current UTC time. "
        + (workspace
          ? "Use list_files for workspace structure questions. Only describe files returned by the tool. "
          + "Explain when listing results are incomplete. File contents are not available."
          : "No workspace is selected; repository tools are unavailable."),
    },
    { role: "user", content: prompt },
  ];

  let toolCallsUsed = 0;

  while (true) {
    const availableTools = workspace ? [currentTimeTool, listFilesTool] : [currentTimeTool];
    const tools = toolCallsUsed < maxToolCalls ? availableTools : [];
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

      let result: unknown;
      if (call.name === currentTimeTool.function.name) {
        if (Object.keys(call.arguments).length > 0) {
          result = { error: "Invalid arguments for get_current_time: expected an empty object." };
        }
        else {
          console.error("[tool] get_current_time");
          result = { utc: new Date().toISOString() };
        }
      }
      else if (call.name === listFilesTool.function.name && workspace) {
        const valid = Object.keys(call.arguments).every(key => key === "directory")
          && (call.arguments.directory === undefined || typeof call.arguments.directory === "string");
        if (!valid) {
          result = { error: "Invalid arguments for list_files: expected only an optional string directory." };
        }
        else {
          try {
            console.error("[tool] list_files");
            result = await listFiles(workspace, call.arguments.directory as string | undefined);
          }
          catch (error) {
            const detail = error instanceof Error && !("code" in error)
              ? error.message
              : "Directory is missing or inaccessible.";
            result = { error: `Could not list files: ${detail}` };
          }
        }
      }
      else {
        result = { error: `Unknown tool: ${call.name}. Available tools: ${availableTools.map(tool => tool.function.name).join(", ")}.` };
      }

      messages.push({
        role: "tool",
        tool_name: call.name,
        content: JSON.stringify(result),
      });
    }
  }
}
