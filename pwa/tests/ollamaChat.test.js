import test from 'node:test';
import assert from 'node:assert/strict';
import { runOllamaToolChat } from '../src/lib/ollamaChat.js';

const encoder = new TextEncoder();
function streamResponse(records, { status = 200 } = {}) {
  const body = new ReadableStream({
    start(controller) {
      for (const record of records) controller.enqueue(encoder.encode(JSON.stringify(record) + '\n'));
      controller.close();
    }
  });
  return new Response(body, { status });
}
const assistant = (content = '', toolCalls = []) => ({
  message: { role: 'assistant', content, tool_calls: toolCalls }
});
const toolCall = (name, args = {}) => ({ function: { name, arguments: args } });

function setup(fetchResponses, overrides = {}) {
  const requests = [];
  const events = [];
  const text = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options, payload: JSON.parse(options.body) });
    const next = fetchResponses.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  return {
    requests, events, text,
    run: options => runOllamaToolChat({
      baseUrl: 'http://localhost:11434/',
      model: 'qwen2.5:1.5b',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [{ type: 'function', function: { name: 'echo' } }],
      fetchImpl,
      executeTool: async () => ({ ok: true }),
      onEvent: event => events.push(event),
      onText: value => text.push(value),
      maxRetries: 0,
      ...overrides,
      ...options
    })
  };
}

test('streams a normal answer and finishes when the model returns no tool calls', async () => {
  const harness = setup([streamResponse([assistant('Hello'), assistant(' there')])]);
  const result = await harness.run();
  assert.equal(result.answer, 'Hello there');
  assert.equal(result.turns, 1);
  assert.deepEqual(harness.text, ['Hello', 'Hello there']);
  assert.equal(harness.requests[0].url, 'http://localhost:11434/api/chat');
});


test('reports first-token latency and Ollama prompt/generation throughput', async () => {
  const harness = setup([streamResponse([
    assistant('Measured response'),
    { ...assistant(), done: true, prompt_eval_count: 120, prompt_eval_duration: 500_000_000, eval_count: 80, eval_duration: 2_000_000_000, load_duration: 250_000_000, total_duration: 2_900_000_000 }
  ])]);
  const result = await harness.run();
  const metrics = harness.events.find(event => event.type === 'metrics')?.metrics;
  const summary = result.metrics;
  assert.ok(metrics);
  assert.ok(metrics.firstTokenMs >= 0);
  assert.equal(metrics.promptTokens, 120);
  assert.equal(metrics.promptEvalMs, 500);
  assert.equal(metrics.generatedTokens, 80);
  assert.equal(metrics.generationMs, 2000);
  assert.equal(metrics.tokensPerSecond, 40);
  assert.equal(metrics.modelLoadMs, 250);
  assert.equal(metrics.modelReportedTotalMs, 2900);
  assert.equal(summary.modelTurns, 1);
  assert.equal(summary.modelLoadMs, 250);
  assert.equal(summary.modelReportedTotalMs, 2900);
  assert.equal(summary.promptTokensPerSecond, 240);
  assert.ok(summary.wallTimeMs >= summary.firstTokenMs);
});

test('executes tool calls sequentially and sends serialized results back to Ollama', async () => {
  const order = [];
  const harness = setup([
    streamResponse([assistant('', [toolCall('first', '{"value":1}'), toolCall('second', { value: 2 })])]),
    streamResponse([assistant('Done')])
  ], {
    executeTool: async (name, args) => { order.push(name); return { name, args }; }
  });
  const result = await harness.run();
  assert.deepEqual(order, ['first', 'second']);
  assert.equal(result.answer, 'Done');
  assert.deepEqual(harness.requests[1].payload.messages.slice(-2).map(message => message.role), ['tool', 'tool']);
  assert.deepEqual(JSON.parse(harness.requests[1].payload.messages.at(-2).content), { name: 'first', args: { value: 1 } });
});

test('returns tool errors to the model and continues the conversation', async () => {
  const harness = setup([
    streamResponse([assistant('', [toolCall('broken')])]),
    streamResponse([assistant('Recovered')])
  ], { executeTool: async () => { throw new Error('service unavailable'); } });
  const result = await harness.run();
  assert.equal(result.answer, 'Recovered');
  assert.deepEqual(JSON.parse(harness.requests[1].payload.messages.at(-1).content), { error: 'service unavailable' });
  assert.ok(harness.events.some(event => event.type === 'tool.failed'));
});

test('records user-declined approval as a tool result without executing it', async () => {
  let executed = false;
  const harness = setup([
    streamResponse([assistant('', [toolCall('dangerous')])]),
    streamResponse([assistant('No action taken')])
  ], {
    getToolMeta: () => ({ requiresApproval: true }),
    confirmTool: async () => false,
    executeTool: async () => { executed = true; }
  });
  await harness.run();
  assert.equal(executed, false);
  assert.deepEqual(JSON.parse(harness.requests[1].payload.messages.at(-1).content), {
    cancelled: true, message: 'User declined this action.'
  });
});

test('preserves streamed text when the next Ollama request fails', async () => {
  const harness = setup([
    streamResponse([assistant('Partial'), assistant('', [toolCall('next')])]),
    new Error('connection lost')
  ]);
  await assert.rejects(harness.run(), /connection lost/);
  assert.equal(harness.text.at(-1), 'Partial');
});

test('rejects malformed tool arguments and missing tool names', async () => {
  const malformed = setup([streamResponse([assistant('', [toolCall('echo', '{')])])]);
  await assert.rejects(malformed.run(), /arguments for echo were not valid JSON/);
  const unnamed = setup([streamResponse([assistant('', [{ function: { arguments: {} } }])])]);
  await assert.rejects(unnamed.run(), /without a function name/);
});

test('enforces the tool-loop safety limit', async () => {
  const endless = setup(Array.from({ length: 2 }, () => streamResponse([assistant('', [toolCall('again')])])),
    { maxTurns: 2 });
  await assert.rejects(endless.run(), /2-turn safety limit/);
});

test('propagates cancellation to fetch and stops before starting another tool', async () => {
  const controller = new AbortController();
  let executed = 0;
  const harness = setup([streamResponse([assistant('', [toolCall('first'), toolCall('second')])])], {
    signal: controller.signal,
    executeTool: async name => {
      executed += 1;
      if (name === 'first') controller.abort(new Error('user stopped'));
      return 'ok';
    }
  });
  await assert.rejects(harness.run(), /user stopped/);
  assert.equal(executed, 1);
  assert.equal(harness.requests[0].options.signal, controller.signal);
});

test('reports HTTP errors before attempting to parse a stream', async () => {
  const harness = setup([new Response('unavailable', { status: 503 })]);
  await assert.rejects(harness.run(), /HTTP 503/);
});

test('explains Ollama model-not-installed 404 responses instead of hiding the upstream detail', async () => {
  const harness = setup([new Response(JSON.stringify({ error: "model 'qwen2.5:1.5b' not found, try pulling it first" }), {
    status: 404, headers: { 'content-type': 'application/json' }
  })]);
  await assert.rejects(harness.run(), error => {
    assert.match(error.message, /Ollama model is not installed/);
    assert.ok(error.message.includes('qwen2.5:1.5b'));
    assert.match(error.message, /Open Model Store/);
    return true;
  });
});

test('preserves useful plain-text details for other Ollama HTTP failures', async () => {
  const harness = setup([new Response('route unavailable', { status: 404 })]);
  await assert.rejects(harness.run(), /Ollama returned HTTP 404: route unavailable/);
});

test('supports ordinary multi-turn chat without registering tools', async () => {
  const history = [
    { role: 'user', content: 'My project is called Axiom.' },
    { role: 'assistant', content: 'Got it.' },
    { role: 'user', content: 'What is my project called?' }
  ];
  const harness = setup([streamResponse([assistant('Axiom')])]);
  const result = await harness.run({ tools: [], messages: history });
  assert.equal(result.answer, 'Axiom');
  assert.deepEqual(harness.requests[0].payload.messages, history);
  assert.equal(Object.hasOwn(harness.requests[0].payload, 'tools'), false);
});

test('aggregates model metrics across tool turns', async () => {
  const harness = setup([
    streamResponse([{ ...assistant('', [toolCall('echo')]), done: true, prompt_eval_count: 40, prompt_eval_duration: 200_000_000, eval_count: 10, eval_duration: 500_000_000, load_duration: 100_000_000, total_duration: 900_000_000 }]),
    streamResponse([{ ...assistant('Finished'), done: true, prompt_eval_count: 60, prompt_eval_duration: 300_000_000, eval_count: 20, eval_duration: 1_000_000_000, load_duration: 0, total_duration: 1_400_000_000 }])
  ]);
  const result = await harness.run();
  assert.equal(result.metrics.promptTokens, 100);
  assert.equal(result.metrics.generatedTokens, 30);
  assert.equal(result.metrics.promptEvalMs, 500);
  assert.equal(result.metrics.generationMs, 1500);
  assert.equal(result.metrics.modelLoadMs, 100);
  assert.equal(result.metrics.modelReportedTotalMs, 2300);
  assert.equal(result.metrics.modelTurns, 2);
  assert.equal(result.metrics.tokensPerSecond, 20);
  assert.ok(result.metrics.firstTokenMs >= 0);
  assert.ok(result.metrics.wallTimeMs >= result.metrics.firstTokenMs);
});
