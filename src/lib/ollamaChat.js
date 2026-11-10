import { consumeNdjsonStream } from './ndjson.js';

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason || new DOMException('Operation aborted', 'AbortError');
}

/**
 * Run an Ollama /api/chat conversation with sequential tool execution.
 * Callbacks keep UI state and logging outside this runtime so the loop can be
 * exercised deterministically without a browser or a live Ollama instance.
 */
export async function runOllamaToolChat({
  baseUrl,
  model,
  messages,
  tools,
  signal,
  fetchImpl = fetch,
  executeTool,
  serializeToolResult = value => JSON.stringify(value) ?? 'null',
  getToolMeta = () => undefined,
  confirmTool = async () => true,
  onText = () => {},
  onEvent = () => {},
  maxTurns = 5
}) {
  if (typeof executeTool !== 'function') throw new TypeError('executeTool is required');
  if (!Number.isInteger(maxTurns) || maxTurns < 1) throw new TypeError('maxTurns must be a positive integer');

  const conversation = messages.map(message => ({ role: message.role, content: message.content }));
  let answer = '';

  for (let turn = 0; turn < maxTurns; turn += 1) {
    throwIfAborted(signal);
    const payload = { model, messages: conversation, tools, stream: true };
    onEvent({ type: 'request', endpoint: '/api/chat', turn, model, toolCount: tools.length });

    const response = await fetchImpl(baseUrl.replace(/\/$/, '') + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal
    });
    if (!response.ok) throw new Error('Ollama returned HTTP ' + response.status);

    let turnContent = '';
    let thinking = '';
    const calls = [];
    await consumeNdjsonStream(response, chunk => {
      const part = chunk.message || {};
      if (part.thinking) thinking += part.thinking;
      if (part.content) {
        turnContent += part.content;
        answer += part.content;
        onText(answer);
      }
      if (Array.isArray(part.tool_calls)) calls.push(...part.tool_calls);
    }, { signal });

    conversation.push({ role: 'assistant', thinking, content: turnContent, tool_calls: calls });
    if (!calls.length) return { answer, conversation, turns: turn + 1 };

    for (const call of calls) {
      throwIfAborted(signal);
      const name = call.function?.name;
      if (typeof name !== 'string' || !name.trim()) throw new Error('Ollama returned a tool call without a function name');
      let args = call.function.arguments ?? {};
      if (typeof args === 'string') {
        try { args = JSON.parse(args); }
        catch { throw new Error('Tool arguments for ' + name + ' were not valid JSON'); }
      }
      onEvent({ type: 'tool.request', name, args });

      const meta = getToolMeta(name);
      if (meta?.requiresApproval && !(await confirmTool(name, args))) {
        conversation.push({
          role: 'tool',
          tool_name: name,
          content: JSON.stringify({ cancelled: true, message: 'User declined this action.' })
        });
        onEvent({ type: 'tool.declined', name });
        continue;
      }

      try {
        const result = await executeTool(name, args, { signal });
        const serialized = serializeToolResult(result);
        conversation.push({ role: 'tool', tool_name: name, content: serialized });
        onEvent({ type: 'tool.completed', name, result: serialized });
      } catch (error) {
        if (signal?.aborted) throw error;
        const message = error?.message || String(error);
        conversation.push({ role: 'tool', tool_name: name, content: JSON.stringify({ error: message }) });
        onEvent({ type: 'tool.failed', name, error: message });
      }
    }
  }

  throw new Error('Tool execution reached the ' + maxTurns + '-turn safety limit before the model finished. Review the tool results and send a follow-up if needed.');
}
