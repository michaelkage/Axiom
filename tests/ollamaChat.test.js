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
  await assert.rejects(endless.run(), /two-turn safety limit/);
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
