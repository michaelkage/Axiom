import { consumeNdjsonStream } from './ndjson.js';

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason || new DOMException('Operation aborted', 'AbortError');
}

async function ollamaHttpError(response) {
  let detail = '';
  try {
    const body = await response.text();
    if (body) {
      try {
        const payload = JSON.parse(body);
        detail = payload.error || payload.message || body;
      } catch {
        detail = body;
      }
    }
  } catch {
    // Preserve the HTTP status even if the upstream error body cannot be read.
  }
  detail = String(detail).replace(/[\\r\\n\\t]+/g, ' ').trim().slice(0, 1200);
  const modelMissing = response.status === 404 && /model.{0,100}(not found|does not exist)|(not found|does not exist).{0,100}model/i.test(detail);
  if (modelMissing) {
    return new Error(`Ollama model is not installed: ${detail}. Open Model Store, pull this model onto the Ollama host, then retry.`);
  }
  return new Error('Ollama returned HTTP ' + response.status + (detail ? ': ' + detail : ''));
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
  tools = [],
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
  const runStartedAt = Date.now();
  let firstTokenMs = null;
  let modelLoadMs = 0;
  let promptEvalMs = 0;
  let generationMs = 0;
  let promptTokens = 0;
  let generatedTokens = 0;
  let modelReportedTotalMs = 0;

  for (let turn = 0; turn < maxTurns; turn += 1) {
    throwIfAborted(signal);
    const payload = { model, messages: conversation, stream: true };
    if (tools.length) payload.tools = tools;
    onEvent({ type: 'request', endpoint: '/api/chat', turn, model, toolCount: tools.length });

    const requestStartedAt = Date.now();
    const response = await fetchImpl(baseUrl.replace(/\/$/, '') + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal
    });
    if (!response.ok) throw await ollamaHttpError(response);

    let turnContent = '';
    let thinking = '';
    let firstTokenAt = null;
    let finalStats = null;
    const calls = [];
    await consumeNdjsonStream(response, chunk => {
      finalStats = chunk;
      if (chunk.message?.content && firstTokenAt === null) firstTokenAt = Date.now();
      const part = chunk.message || {};
      if (part.thinking) thinking += part.thinking;
      if (part.content) {
        turnContent += part.content;
        answer += part.content;
        onText(answer);
      }
      if (Array.isArray(part.tool_calls)) calls.push(...part.tool_calls);
    }, { signal });

    const turnGenerationMs = Number(finalStats?.eval_duration || 0) / 1e6;
    const turnLoadMs = Number(finalStats?.load_duration || 0) / 1e6;
    const turnPromptEvalMs = Number(finalStats?.prompt_eval_duration || 0) / 1e6;
    const turnPromptTokens = Number(finalStats?.prompt_eval_count || 0);
    const turnGeneratedTokens = Number(finalStats?.eval_count || 0);
    const turnTotalMs = Number(finalStats?.total_duration || 0) / 1e6;
    const turnFirstTokenMs = firstTokenAt === null ? null : firstTokenAt - requestStartedAt;
    if (firstTokenMs === null && turnFirstTokenMs !== null) firstTokenMs = turnFirstTokenMs;
    modelLoadMs += turnLoadMs;
    promptEvalMs += turnPromptEvalMs;
    generationMs += turnGenerationMs;
    promptTokens += turnPromptTokens;
    generatedTokens += turnGeneratedTokens;
    modelReportedTotalMs += turnTotalMs;
    onEvent({ type: 'metrics', metrics: {
      turn: turn + 1, firstTokenMs: turnFirstTokenMs,
      promptTokens: turnPromptTokens || null,
      promptEvalMs: turnPromptEvalMs ? Math.round(turnPromptEvalMs) : null,
      promptTokensPerSecond: turnPromptEvalMs > 0 && turnPromptTokens > 0 ? Math.round(turnPromptTokens / (turnPromptEvalMs / 1000) * 10) / 10 : null,
      generatedTokens: turnGeneratedTokens || null,
      generationMs: turnGenerationMs ? Math.round(turnGenerationMs) : null,
      tokensPerSecond: turnGenerationMs > 0 && turnGeneratedTokens > 0 ? Math.round(turnGeneratedTokens / (turnGenerationMs / 1000) * 10) / 10 : null,
      modelLoadMs: turnLoadMs ? Math.round(turnLoadMs) : null,
      modelReportedTotalMs: turnTotalMs ? Math.round(turnTotalMs) : null
    } });
    conversation.push({ role: 'assistant', thinking, content: turnContent, tool_calls: calls });
    if (!calls.length) {
      const metrics = {
        firstTokenMs, promptTokens, promptEvalMs: Math.round(promptEvalMs),
        promptTokensPerSecond: promptEvalMs > 0 && promptTokens > 0 ? Math.round(promptTokens / (promptEvalMs / 1000) * 10) / 10 : null,
        generatedTokens, generationMs: Math.round(generationMs),
        tokensPerSecond: generationMs > 0 && generatedTokens > 0 ? Math.round(generatedTokens / (generationMs / 1000) * 10) / 10 : null,
        modelLoadMs: Math.round(modelLoadMs), modelReportedTotalMs: Math.round(modelReportedTotalMs),
        wallTimeMs: Date.now() - runStartedAt, modelTurns: turn + 1
      };
      onEvent({ type: 'metrics.summary', metrics });
      return { answer, conversation, turns: turn + 1, metrics };
    }

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
      if (meta?.requiresApproval && !(await confirmTool(name, args, { signal }))) {
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
