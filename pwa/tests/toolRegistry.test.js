import test from 'node:test';
import assert from 'node:assert/strict';
import { executeTool, listTools, registerTool, serializeToolResult, validateToolInput } from '../src/lib/toolRegistry.js';

test('registers, validates, executes, and unregisters an async tool', async () => {
  const unregister = registerTool({
    name: 'test_echo',
    description: 'Echo a message',
    inputSchema: {
      type: 'object',
      properties: { message: { type: 'string', minLength: 1 } },
      required: ['message'],
      additionalProperties: false
    }
  }, async ({ message }) => ({ echoed: message }));
  try {
    assert.ok(listTools().some(tool => tool.name === 'test_echo'));
    assert.deepEqual(await executeTool('test_echo', { message: 'hello' }), { echoed: 'hello' });
  } finally {
    unregister();
  }
  assert.ok(!listTools().some(tool => tool.name === 'test_echo'));
});

test('rejects missing required fields and unexpected properties', () => {
  const schema = {
    type: 'object',
    properties: { value: { type: 'integer' } },
    required: ['value'],
    additionalProperties: false
  };
  assert.throws(() => validateToolInput(schema, {}), /is required/);
  assert.throws(() => validateToolInput(schema, { value: 1, extra: true }), /is not allowed/);
  assert.throws(() => validateToolInput(schema, { value: 'wrong' }), /must be integer/);
});

test('validates nested arrays and numeric bounds', () => {
  const schema = {
    type: 'object',
    properties: {
      ports: { type: 'array', minItems: 1, maxItems: 2, items: { type: 'integer', minimum: 1, maximum: 65535 } }
    },
    required: ['ports'],
    additionalProperties: false
  };
  assert.equal(validateToolInput(schema, { ports: [80, 443] }), true);
  assert.throws(() => validateToolInput(schema, { ports: [] }), /too few items/);
  assert.throws(() => validateToolInput(schema, { ports: [70000] }), /exceeds the maximum/);
  assert.throws(() => validateToolInput(schema, { ports: [80, '443'] }), /must be integer/);
});


test('serializes undefined tool results as JSON null', () => {
  assert.equal(serializeToolResult(undefined), 'null');
});

test('serializes normal tool results as JSON', () => {
  assert.equal(serializeToolResult({ ok: true, count: 2 }), '{"ok":true,"count":2}');
});

test('redacts secrets from serialized tool results before returning them to a model', () => {
  const result = serializeToolResult({ token: 'ghp_abcdefghijklmnopqrstuvwxyz123456', output: 'API_KEY=private-value' });
  assert.doesNotMatch(result, /ghp_abcdefghijklmnopqrstuvwxyz123456/);
  assert.doesNotMatch(result, /private-value/);
  assert.match(result, /\\[REDACTED\\]/);
});

test('rejects circular and BigInt tool results with a useful error', () => {
  const circular = {};
  circular.self = circular;
  assert.throws(() => serializeToolResult(circular), /not JSON-serializable/);
  assert.throws(() => serializeToolResult(1n), /not JSON-serializable/);
});


test('rejects unsupported schema types instead of silently accepting values', () => {
  assert.throws(
    () => validateToolInput({ type: 'date' }, '2026-11-09'),
    /unsupported schema type: date/
  );
  assert.throws(() => validateToolInput(null, {}), /invalid schema/);
});

test('supports JSON Schema union types and validates the matching branch', () => {
  const nullableString = { type: ['string', 'null'], minLength: 2 };
  assert.equal(validateToolInput(nullableString, null), true);
  assert.equal(validateToolInput(nullableString, 'ok'), true);
  assert.throws(() => validateToolInput(nullableString, 'x'), /too short/);
  assert.throws(() => validateToolInput(nullableString, 3), /must be string or null/);

  const mixed = { type: ['object', 'string'], properties: { name: { type: 'string' } }, required: ['name'] };
  assert.equal(validateToolInput(mixed, 'plain text'), true);
  assert.equal(validateToolInput(mixed, { name: 'Axiom' }), true);
  assert.throws(() => validateToolInput(mixed, {}), /name is required/);
});


test('bounds schema nesting and rejects malformed schema keywords', () => {
  let nested = { type: 'string' };
  for (let index = 0; index < 66; index++) nested = { type: 'array', items: nested };
  let value = 'ok';
  for (let index = 0; index < 66; index++) value = [value];
  assert.throws(() => validateToolInput(nested, value), /maximum schema\/input nesting depth/);

  assert.throws(() => validateToolInput({ type: 'object', properties: [] }, {}), /invalid properties schema/);
  assert.throws(() => validateToolInput({ type: 'object', required: 'name' }, {}), /invalid required schema/);
  assert.throws(() => validateToolInput({ type: 'array', items: null }, []), /invalid items schema/);
  assert.throws(() => validateToolInput({ type: 'string', enum: 'yes' }, 'yes'), /invalid enum schema/);
});

test('rejects invalid or excessively long regular-expression schemas', () => {
  assert.throws(() => validateToolInput({ type: 'string', pattern: '[' }, 'value'), /invalid pattern schema/);
  assert.throws(() => validateToolInput({ type: 'string', pattern: 'a'.repeat(513) }, 'value'), /invalid pattern schema/);
});


test('aborts a tool and rejects when its execution timeout expires', async () => {
  let receivedSignal;
  const unregister = registerTool({
    name: 'test_timeout',
    timeoutMs: 10,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  }, async (_input, { signal }) => {
    receivedSignal = signal;
    return await new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  });
  try {
    await assert.rejects(executeTool('test_timeout', {}), /Tool timed out after 10ms/);
    assert.equal(receivedSignal.aborted, true);
  } finally {
    unregister();
  }
});

test('uses the default timeout for tools and rejects invalid timeout configuration', () => {
  const unregister = registerTool({
    name: 'test_default_timeout',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  }, async () => 'ok');
  try {
    assert.equal(listTools().find(tool => tool.name === 'test_default_timeout').timeoutMs, 30000);
  } finally {
    unregister();
  }
  assert.throws(() => registerTool({ name: 'test_invalid_timeout', timeoutMs: 0 }, async () => null), /timeoutMs/);
  assert.throws(() => registerTool({ name: 'test_long_timeout', timeoutMs: 120001 }, async () => null), /timeoutMs/);
});


test('propagates caller cancellation to a running tool and rejects promptly', async () => {
  let receivedSignal;
  const unregister = registerTool({
    name: 'test_parent_cancellation',
    timeoutMs: 1000,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  }, async (_input, { signal }) => {
    receivedSignal = signal;
    return await new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  });
  const controller = new AbortController();
  try {
    const pending = executeTool('test_parent_cancellation', {}, { signal: controller.signal });
    await new Promise(resolve => setImmediate(resolve));
    controller.abort(new Error('caller cancelled'));
    await assert.rejects(pending, /caller cancelled/);
    assert.equal(receivedSignal.aborted, true);
  } finally {
    unregister();
  }
});

test('does not start a tool when its caller signal is already aborted', async () => {
  let called = false;
  const unregister = registerTool({
    name: 'test_pre_aborted',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  }, async () => { called = true; });
  const controller = new AbortController();
  controller.abort(new Error('already cancelled'));
  try {
    await assert.rejects(executeTool('test_pre_aborted', {}, { signal: controller.signal }), /already cancelled/);
    assert.equal(called, false);
  } finally {
    unregister();
  }
});
