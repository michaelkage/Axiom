import test from 'node:test';
import assert from 'node:assert/strict';
import { executeTool, listTools, registerTool, validateToolInput } from '../src/lib/toolRegistry.js';

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
