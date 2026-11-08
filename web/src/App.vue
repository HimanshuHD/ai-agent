<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import * as api from "./api";
type Turn = { prompt: string; answer: string; state: "running" | "completed" | "failed" | "cancelled"; tools: api.ToolEvent[]; error?: string };
const connection = ref<api.Connection>();
const connecting = ref(false);
const working = ref(false);
const cancelling = ref(false);
const prompt = ref("");
const notice = ref("");
const error = ref("");
const turns = ref<Turn[]>([]);
const input = ref<HTMLTextAreaElement>();
const bottom = ref<HTMLElement>();
let active: AbortController | undefined;
const busy = computed(() => working.value || connecting.value);
const suggestions = computed(() => connection.value?.workspaceEnabled
  ? ["Search for runAgent and explain startup with citations.", "List the source files in this workspace.", "What is the current UTC time?"]
  : ["Explain a Vue composable in two sentences.", "What is the current UTC time?", "Help me understand JavaScript closures."]);
async function scroll() { await nextTick(); bottom.value?.scrollIntoView({ block: "end" }); }
async function open() {
  if (busy.value) return;
  connecting.value = true;
  error.value = "";
  try {
    if (connection.value) await api.disconnect(connection.value.token).catch(() => {});
    connection.value = undefined;
    connection.value = await api.connect();
    turns.value = [];
    notice.value = "A new private conversation is ready.";
  }
  catch (problem) { error.value = problem instanceof Error ? problem.message : "Connection failed."; }
  finally { connecting.value = false; }
}
async function send() {
  if (busy.value || !connection.value || !prompt.value.trim()) return;
  const text = prompt.value.trim();
  if (new TextEncoder().encode(text).length > 16_384) { error.value = "Keep your message within 16 KiB of text."; return; }
  working.value = true;
  error.value = "";
  notice.value = "";
  prompt.value = "";
  turns.value.push({ prompt: text, answer: "", state: "running", tools: [] });
  const current = turns.value[turns.value.length - 1];
  active = new AbortController();
  await scroll();
  try {
    await api.run(connection.value.token, text, (event) => {
      if (event.type === "tool") current.tools.push(event);
      else if (event.type === "answer") {
        current.answer = event.answer;
        current.state = "completed";
        if (event.droppedTurns) notice.value = `${event.droppedTurns} complete turn(s) left model context to keep history bounded. Older messages shown here may no longer be in context.`;
      }
      else if (event.type === "cancelled") current.state = "cancelled";
      else if (event.type === "error") { current.state = "failed"; current.error = event.message; }
      void scroll();
    }, active.signal);
  }
  catch (problem) {
    if (current.state === "running") { current.state = "failed"; current.error = problem instanceof Error ? problem.message : "Run failed."; }
  }
  finally {
    active = undefined;
    working.value = false;
    cancelling.value = false;
    if (turns.value.length > 20) turns.value.splice(0, turns.value.length - 20);
    await nextTick();
    input.value?.focus();
    await scroll();
  }
}
async function stop() {
  if (!connection.value || !working.value || cancelling.value) return;
  cancelling.value = true;
  try { await api.cancel(connection.value.token); }
  catch (problem) { cancelling.value = false; error.value = problem instanceof Error ? problem.message : "Cancellation failed."; }
}
async function clear() {
  if (busy.value || !connection.value) return;
  connecting.value = true;
  error.value = "";
  try { await api.reset(connection.value.token); turns.value = []; notice.value = "Conversation reset. The server workspace is unchanged."; }
  catch (problem) { error.value = problem instanceof Error ? problem.message : "Reset failed."; }
  finally { connecting.value = false; }
}
function choose(text: string) { prompt.value = text; input.value?.focus(); }
function key(event: KeyboardEvent) {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); void send(); }
}
onMounted(open);
onBeforeUnmount(() => active?.abort());
</script>
<template>
  <div class="shell">
    <aside class="sidebar" aria-label="Agent information">
      <a class="brand" href="#main"><span class="brand-icon" aria-hidden="true">⌘</span>local<span>agent</span><small>YOUR LOCAL WORKSPACE</small></a>
      <div class="side-label">
        CONVERSATION
      </div>
      <button class="side-button" :disabled="busy || !connection" @click="clear">
        <span aria-hidden="true">+</span> Reset conversation
      </button>
      <div class="workspace-card">
        <span class="dot" /> LOCAL CONNECTION<strong>{{ connection ? connection.model : 'Waiting for backend' }}</strong><p>{{ connection?.workspaceEnabled ? 'Repository tools enabled. Access stays within the server-selected workspace.' : 'General questions and the UTC time tool. Select a workspace at server startup for repository access.' }}</p>
      </div>
      <div class="side-label">
        HOW IT WORKS
      </div>
      <ol class="steps">
        <li><b>01</b><span>Ask a question<small>Start with what you want to understand.</small></span></li><li><b>02</b><span>Watch the tools<small>See when the agent inspects your code.</small></span></li><li><b>03</b><span>Follow the evidence<small>Check source references in answers.</small></span></li>
      </ol>
      <div class="side-footer">
        ◈ Ollama runs on your machine.<small>Conversations stay in server memory and expire automatically.</small>
      </div>
    </aside>
    <main id="main" class="main">
      <header class="topbar">
        <div><span class="eyebrow">LOCAL AGENT / CHAT</span><h1>A conversation with your code.</h1></div><div class="connection">
          <span class="dot" :class="{ offline: !connection }" />{{ connecting ? 'Connecting…' : connection ? 'Backend connected' : 'Disconnected' }}
        </div>
      </header>
      <div class="toolbar">
        <span>One conversation. A little more clarity.</span><button class="text-button" :disabled="busy" @click="open">
          {{ connection ? 'New connection' : 'Retry connection' }}
        </button>
      </div>
      <p v-if="error" class="global-error" role="alert">
        {{ error }}
      </p><p v-if="notice" class="notice" role="status">
        {{ notice }}
      </p>
      <section class="conversation" aria-label="Conversation history" aria-live="polite" aria-relevant="additions text">
        <div v-if="!turns.length" class="welcome">
          <div class="welcome-icon" aria-hidden="true">
            ✳
          </div><span class="eyebrow">MAKE SENSE OF WHAT'S IN FRONT OF YOU</span><h2>Start with a good question.</h2><p>Trace a function, explore an idea, or find your next step.<br>The agent brings tools. You bring the curiosity.</p><div class="suggestions">
            <button v-for="suggestion in suggestions" :key="suggestion" :disabled="busy || !connection" @click="choose(suggestion)">
              {{ suggestion }}<span aria-hidden="true">↗</span>
            </button>
          </div>
        </div>
        <article v-for="(turn, index) in turns" :key="index" class="turn">
          <div class="message user">
            <span class="avatar">YOU</span><div><h2>You</h2><p>{{ turn.prompt }}</p></div>
          </div><div class="message assistant">
            <span class="avatar agent-avatar" aria-hidden="true">✳</span><div class="answer">
              <div class="answer-heading">
                <h2>Local Agent</h2><span class="state" :class="turn.state">{{ turn.state }}</span>
              </div><ul v-if="turn.tools.length" class="tool-list" aria-label="Tool activity">
                <li v-for="(tool, position) in turn.tools" :key="position" :class="tool.status">
                  <span aria-hidden="true">{{ tool.status === 'failed' ? '!' : tool.status === 'running' ? '◌' : '✓' }}</span><code>{{ tool.name }}</code><span>{{ tool.status }}</span><p v-if="tool.error">
                    {{ tool.error }}
                  </p>
                </li>
              </ul><p v-if="turn.answer" class="answer-text">
                {{ turn.answer }}
              </p><p v-if="turn.state === 'running'" class="thinking">
                {{ cancelling ? 'Cancelling the active request…' : 'Working through your question…' }}
              </p><p v-if="turn.error" class="turn-error" role="alert">
                {{ turn.error }}
              </p><p v-if="turn.state === 'cancelled'" class="muted">
                Run cancelled. This turn was not saved in model history.
              </p>
            </div>
          </div>
        </article><div ref="bottom" />
      </section>
      <footer class="composer-area">
        <form class="composer" @submit.prevent="send">
          <label class="sr-only" for="prompt">Message the local agent</label><textarea id="prompt" ref="input" v-model="prompt" :disabled="busy || !connection" rows="2" placeholder="Ask about your code, or explore an idea…" @keydown="key" /><div class="composer-bottom">
            <span>Enter to send · Shift + Enter for a new line</span><button v-if="working" type="button" class="cancel-button" :disabled="cancelling" @click="stop">
              {{ cancelling ? 'Cancelling…' : 'Cancel run' }}
            </button><button v-else class="send-button" type="submit" :disabled="busy || !connection || !prompt.trim()">
              Send message ↑
            </button>
          </div>
        </form><p class="footnote">
          Answers can be imperfect. Verify important details and source references.
        </p>
      </footer>
    </main>
  </div>
</template>
