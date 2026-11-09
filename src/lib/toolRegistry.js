/**
 * Axiom's async tool registry. Tool definitions are JSON-Schema-shaped and
 * execution is always explicit; registering a tool never executes it.
 */
const tools = new Map();
const listeners = new Set();

function emit(event) {
  for (const listener of listeners) {
    try { listener(event); } catch { /* Observability listeners cannot break tool execution. */ }
  }
}
export function subscribeToolEvents(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function listTools() {
  return [...tools.values()].map(({ handler, ...publicTool }) => publicTool);
}
export function registerTool(definition, handler) {
  if (!definition?.name || typeof handler !== 'function') throw new TypeError('A tool name and async handler are required.');
  if (tools.has(definition.name)) throw new Error('Tool already registered: ' + definition.name);
  const entry = {
    description: '',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    ...definition,
    handler
  };
  tools.set(entry.name, entry);
  emit({ type: 'tool.registered', name: entry.name });
  let registered = true;
  return () => {
    if (!registered) return;
    registered = false;
    if (tools.get(entry.name) === entry) tools.delete(entry.name);
    emit({ type: 'tool.unregistered', name: entry.name });
  };
}
export function validateToolInput(schema, value, path = 'input') {
  if (!schema || schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(path + ' must be an object');
    for (const key of schema?.required || []) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) throw new TypeError(path + '.' + key + ' is required');
    }
    for (const [key, child] of Object.entries(schema?.properties || {})) {
      if (Object.prototype.hasOwnProperty.call(value, key)) validateToolInput(child, value[key], path + '.' + key);
    }
    if (schema?.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(schema.properties || {}, key)) throw new TypeError(path + '.' + key + ' is not allowed');
      }
    }
    return true;
  }
  const valid = schema.type === 'string' ? typeof value === 'string'
    : schema.type === 'number' ? typeof value === 'number' && Number.isFinite(value)
    : schema.type === 'integer' ? Number.isInteger(value)
    : schema.type === 'boolean' ? typeof value === 'boolean'
    : schema.type === 'array' ? Array.isArray(value)
    : schema.type === 'null' ? value === null : true;
  if (!valid) throw new TypeError(path + ' must be ' + schema.type);
  if (schema.enum && !schema.enum.includes(value)) throw new TypeError(path + ' must be one of: ' + schema.enum.join(', '));
  if (schema.type === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) throw new TypeError(path + ' is too short');
    if (schema.maxLength !== undefined && value.length > schema.maxLength) throw new TypeError(path + ' is too long');
    if (schema.pattern && !(new RegExp(schema.pattern).test(value))) throw new TypeError(path + ' has an invalid format');
  }
  if (schema.type === 'number' || schema.type === 'integer') {
    if (schema.minimum !== undefined && value < schema.minimum) throw new TypeError(path + ' is below the minimum');
    if (schema.maximum !== undefined && value > schema.maximum) throw new TypeError(path + ' exceeds the maximum');
  }
  if (schema.type === 'array') {
    if (schema.minItems !== undefined && value.length < schema.minItems) throw new TypeError(path + ' has too few items');
    if (schema.maxItems !== undefined && value.length > schema.maxItems) throw new TypeError(path + ' has too many items');
    if (schema.items) value.forEach((item, index) => validateToolInput(schema.items, item, path + '[' + index + ']'));
  }
  return true;
}
export async function executeTool(name, input, context = {}) {
  const tool = tools.get(name);
  if (!tool) throw new Error('Unknown tool: ' + name);
  validateToolInput(tool.inputSchema, input);
  const startedAt = Date.now();
  emit({ type: 'tool.started', name, input, startedAt });
  try {
    const result = await tool.handler(input, context);
    emit({ type: 'tool.completed', name, durationMs: Date.now() - startedAt });
    return result;
  } catch (error) {
    emit({ type: 'tool.failed', name, durationMs: Date.now() - startedAt, error: error.message });
    throw error;
  }
}
export function toOllamaTools() {
  return listTools().map(tool => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema }
  }));
}

/**
 * Convert tool output to the JSON string required by Ollama's tool message.
 * Undefined is represented as JSON null; unsupported/circular values fail
 * clearly so the caller can return a tool error instead of malformed context.
 */
export function serializeToolResult(result) {
  let serialized;
  try {
    serialized = JSON.stringify(result);
  } catch (error) {
    throw new TypeError('Tool result is not JSON-serializable: ' + error.message);
  }
  return serialized === undefined ? 'null' : serialized;
}
