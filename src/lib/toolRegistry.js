/**
 * Axiom's async tool registry. Tool definitions are JSON-Schema-shaped and
 * execution is always explicit; registering a tool never executes it.
 */
const tools = new Map();
const listeners = new Set();

function emit(event) { for (const listener of listeners) listener(event); }
export function subscribeToolEvents(listener) { listeners.add(listener); return () => listeners.delete(listener); }
export function listTools() { return [...tools.values()].map(({ handler, ...publicTool }) => publicTool); }
export function registerTool(definition, handler) {
  if (!definition?.name || typeof handler !== 'function') throw new TypeError('A tool name and async handler are required.');
  if (tools.has(definition.name)) throw new Error('Tool already registered: ' + definition.name);
  const entry = { description: '', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, ...definition, handler };
  tools.set(entry.name, entry);
  emit({ type: 'tool.registered', name: entry.name });
  return () => { tools.delete(entry.name); emit({ type: 'tool.unregistered', name: entry.name }); };
}
export function validateToolInput(schema, value, path = 'input') {
  if (!schema || schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(path + ' must be an object');
    for (const key of schema?.required || []) if (!(key in value)) throw new TypeError(path + '.' + key + ' is required');
    for (const [key, child] of Object.entries(schema?.properties || {})) if (key in value) validateToolInput(child, value[key], path + '.' + key);
    if (schema?.additionalProperties === false) for (const key of Object.keys(value)) if (!(key in (schema.properties || {}))) throw new TypeError(path + '.' + key + ' is not allowed');
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
  if (schema.type === 'string' && schema.minLength && value.length < schema.minLength) throw new TypeError(path + ' is too short');
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
  return listTools().map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } }));
}
