import { addNativeModelListener, cancelNativeGeneration, generateNativeText } from './nativeModels.js';

function abortError(signal) {
  if (signal?.aborted) throw signal.reason || new DOMException('Operation aborted', 'AbortError');
}

function parseToolCalls(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(parsed.tool_calls)) return [];
    return parsed.tool_calls.map(item => ({
      name: item.name || item.function?.name,
      arguments: item.arguments ?? item.function?.arguments ?? {}
    })).filter(item => typeof item.name === 'string' && item.name.trim());
  } catch {
    return [];
  }
}

export async function runNativeToolChat({
  model,
  messages,
  tools = [],
  signal,
  executeTool,
  serializeToolResult = value => JSON.stringify(value) ?? 'null',
  getToolMeta = () => undefined,
  confirmTool = async () => true,
  onText = () => {},
  onEvent = () => {},
  maxTurns = 5,
  maxTokens = 768
}) {
  if (typeof executeTool !== 'function') throw new TypeError('executeTool is required');
  if (!Number.isInteger(maxTurns) || maxTurns < 1) throw new TypeError('maxTurns must be a positive integer');

  const conversation = messages.map(message => ({ role: message.role, content: message.content || '' }));
  const startedAt = Date.now();
  let firstTokenMs = null;
  let generatedTokens = 0;
  let answer = '';
  const abort = () => { cancelNativeGeneration().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });

  try {
    for (let turn = 0; turn < maxTurns; turn += 1) {
      abortError(signal);
      const toolPrompt = tools.length
        ? '\n\nAxiom tools are available. If a tool is needed, output ONLY one JSON object with this exact shape: {"tool_calls":[{"name":"tool_name","arguments":{}}]}. Do not wrap it in Markdown. Do not invent tool names. If no tool is needed, answer normally. Available tools and schemas:\n' + JSON.stringify(tools)
        : '';
      const promptMessages = [
        { role: 'system', content: 'You are Axiom, a helpful local assistant. Follow the conversation and answer clearly.' + toolPrompt },
        ...conversation
      ];
      let turnText = '';
      let firstAt = null;
      const listener = await addNativeModelListener('nativeModelToken', event => {
        if (signal?.aborted) return;
        if (firstAt === null) firstAt = Date.now();
        turnText += event.token || '';
        generatedTokens += 1;
        onText(turnText);
      });
      onEvent({ type: 'request', model, turn, toolCount: tools.length, backend: 'llama.cpp' });
      try {
        const result = await generateNativeText(promptMessages, { maxTokens });
        turnText = result.text || turnText;
        if (turn === 0 && firstAt !== null) firstTokenMs = firstAt - startedAt;
      } finally {
        await listener.remove();
      }
      abortError(signal);
      const calls = parseToolCalls(turnText);
      conversation.push({ role: 'assistant', content: turnText });
      if (!calls.length) {
        answer = turnText;
        const wallTimeMs = Date.now() - startedAt;
        const metrics = {
          firstTokenMs,
          generatedTokens,
          generationMs: wallTimeMs,
          tokensPerSecond: wallTimeMs > 0 ? Math.round(generatedTokens / (wallTimeMs / 1000) * 10) / 10 : null,
          wallTimeMs,
          modelTurns: turn + 1,
          backend: 'llama.cpp'
        };
        onEvent({ type: 'metrics.summary', metrics });
        return { answer, conversation, turns: turn + 1, metrics };
      }

      for (const call of calls) {
        abortError(signal);
        let args = call.arguments;
        if (typeof args === 'string') {
          try { args = JSON.parse(args); }
          catch { throw new Error('Native model returned invalid JSON arguments for ' + call.name); }
        }
        if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Native model returned invalid arguments for ' + call.name);
        onEvent({ type: 'tool.request', name: call.name, args });
        const meta = getToolMeta(call.name);
        if (meta?.requiresApproval && !(await confirmTool(call.name, args, { signal }))) {
          conversation.push({ role: 'tool', content: 'Tool ' + call.name + ' was declined by the user.' });
          onEvent({ type: 'tool.declined', name: call.name });
          continue;
        }
        try {
          const result = await executeTool(call.name, args, { signal });
          const serialized = serializeToolResult(result);
          conversation.push({ role: 'tool', content: 'Result from ' + call.name + ': ' + serialized });
          onEvent({ type: 'tool.completed', name: call.name, result: serialized });
        } catch (error) {
          if (signal?.aborted) throw error;
          const message = error?.message || String(error);
          conversation.push({ role: 'tool', content: 'Error from ' + call.name + ': ' + message });
          onEvent({ type: 'tool.failed', name: call.name, error: message });
        }
      }
    }
    throw new Error('Native tool execution reached the ' + maxTurns + '-turn safety limit.');
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}
