import { redactSecrets } from './securityRedaction.js';
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
    timeoutMs: definition.timeoutMs ?? 30000,
    handler
  };
  if (!Number.isInteger(entry.timeoutMs) || entry.timeoutMs < 1 || entry.timeoutMs > 120000) {
    throw new TypeError('Tool timeoutMs must be an integer between 1 and 120000.');
  }
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
export function validateToolInput(schema, value, path = 'input', depth = 0) {
  if (depth > 64) throw new TypeError(path + ' exceeds the maximum schema/input nesting depth');
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new TypeError(path + ' has an invalid schema');
  }

  if (schema.properties !== undefined && (!schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties))) {
    throw new TypeError(path + ' has invalid properties schema');
  }
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some(key => typeof key !== 'string'))) {
    throw new TypeError(path + ' has invalid required schema');
  }
  if (schema.items !== undefined && (!schema.items || typeof schema.items !== 'object' || Array.isArray(schema.items))) {
    throw new TypeError(path + ' has invalid items schema');
  }
  if (schema.enum !== undefined && !Array.isArray(schema.enum)) throw new TypeError(path + ' has invalid enum schema');

  const declaredTypes = schema.type === undefined
    ? []
    : (Array.isArray(schema.type) ? schema.type : [schema.type]);
  const supportedTypes = new Set(['object', 'string', 'number', 'integer', 'boolean', 'array', 'null']);
  for (const type of declaredTypes) {
    if (!supportedTypes.has(type)) throw new TypeError(path + ' uses unsupported schema type: ' + type);
  }

  const matchesType = type => type === 'object'
    ? value !== null && typeof value === 'object' && !Array.isArray(value)
    : type === 'string' ? typeof value === 'string'
    : type === 'number' ? typeof value === 'number' && Number.isFinite(value)
    : type === 'integer' ? Number.isInteger(value)
    : type === 'boolean' ? typeof value === 'boolean'
    : type === 'array' ? Array.isArray(value)
    : type === 'null' ? value === null
    : false;

  if (declaredTypes.length && !declaredTypes.some(matchesType)) {
    throw new TypeError(path + ' must be ' + declaredTypes.join(' or '));
  }

  const inferredObject = declaredTypes.length === 0 &&
    (schema.properties !== undefined || schema.required !== undefined || schema.additionalProperties !== undefined);
  const isObject = value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (declaredTypes.includes('object') || inferredObject);
  const isArray = Array.isArray(value) && (declaredTypes.includes('array') || declaredTypes.length === 0);
  const isString = typeof value === 'string' && (declaredTypes.includes('string') || declaredTypes.length === 0);
  const isNumber = typeof value === 'number' && Number.isFinite(value) &&
    (declaredTypes.includes('number') || declaredTypes.includes('integer') || declaredTypes.length === 0);

  if (schema.enum && !schema.enum.some(item => Object.is(item, value))) {
    throw new TypeError(path + ' must be one of: ' + schema.enum.join(', '));
  }

  if (isObject) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError(path + ' must be an object');
    }
    for (const key of schema.required || []) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) throw new TypeError(path + '.' + key + ' is required');
    }
    for (const [key, child] of Object.entries(schema.properties || {})) {
      if (Object.prototype.hasOwnProperty.call(value, key)) validateToolInput(child, value[key], path + '.' + key, depth + 1);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(schema.properties || {}, key)) {
          throw new TypeError(path + '.' + key + ' is not allowed');
        }
      }
    }
  }

  if (isString) {
    if (schema.minLength !== undefined && value.length < schema.minLength) throw new TypeError(path + ' is too short');
    if (schema.maxLength !== undefined && value.length > schema.maxLength) throw new TypeError(path + ' is too long');
    if (schema.pattern !== undefined) {
      if (typeof schema.pattern !== 'string' || schema.pattern.length > 512) {
        throw new TypeError(path + ' has an invalid pattern schema');
      }
      let pattern;
      try { pattern = new RegExp(schema.pattern); }
      catch { throw new TypeError(path + ' has an invalid pattern schema'); }
      if (!pattern.test(value)) throw new TypeError(path + ' has an invalid format');
    }
  }

  if (isNumber) {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(path + ' must be a finite number');
    if (declaredTypes.includes('integer') && !declaredTypes.includes('number') && !Number.isInteger(value)) {
      throw new TypeError(path + ' must be integer');
    }
    if (schema.minimum !== undefined && value < schema.minimum) throw new TypeError(path + ' is below the minimum');
    if (schema.maximum !== undefined && value > schema.maximum) throw new TypeError(path + ' exceeds the maximum');
  }

  if (isArray) {
    if (!Array.isArray(value)) throw new TypeError(path + ' must be an array');
    if (schema.minItems !== undefined && value.length < schema.minItems) throw new TypeError(path + ' has too few items');
    if (schema.maxItems !== undefined && value.length > schema.maxItems) throw new TypeError(path + ' has too many items');
    if (schema.items) value.forEach((item, index) => validateToolInput(schema.items, item, path + '[' + index + ']', depth + 1));
  }

  return true;
}
export async function executeTool(name, input, context = {}) {
  const tool = tools.get(name);
  if (!tool) throw new Error('Unknown tool: ' + name);
  validateToolInput(tool.inputSchema, input);
  const startedAt = Date.now();
  const controller = new AbortController();
  let timeout;
  emit({ type: 'tool.started', name, input, startedAt, timeoutMs: tool.timeoutMs });
  const executionContext = { ...context, signal: controller.signal };
  const parentSignal = context?.signal;
  let onParentAbort;
  const cancelled = parentSignal?.addEventListener
    ? new Promise((_, reject) => {
      onParentAbort = () => {
        const reason = parentSignal.reason || new Error('Tool execution cancelled: ' + name);
        controller.abort(reason);
        emit({ type: 'tool.cancelled', name, durationMs: Date.now() - startedAt });
        reject(reason);
      };
      if (parentSignal.aborted) onParentAbort();
      else parentSignal.addEventListener('abort', onParentAbort, { once: true });
    })
    : new Promise(() => {});
  const timedOut = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      const error = new Error('Tool timed out after ' + tool.timeoutMs + 'ms: ' + name);
      error.name = 'ToolTimeoutError';
      controller.abort(error);
      emit({ type: 'tool.timed_out', name, durationMs: Date.now() - startedAt, timeoutMs: tool.timeoutMs });
      reject(error);
    }, tool.timeoutMs);
  });
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => {
        if (controller.signal.aborted) throw controller.signal.reason;
        return tool.handler(input, executionContext);
      }),
      timedOut,
      cancelled
    ]);
    emit({ type: 'tool.completed', name, durationMs: Date.now() - startedAt });
    return result;
  } catch (error) {
    if (error?.name !== 'ToolTimeoutError' && !controller.signal.aborted) {
      emit({ type: 'tool.failed', name, durationMs: Date.now() - startedAt, error: error.message });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    parentSignal?.removeEventListener?.('abort', onParentAbort);
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
    serialized = JSON.stringify(typeof result === 'string' ? redactSecrets(result) : result, (_key, value) => typeof value === 'string' ? redactSecrets(value) : value);
  } catch (error) {
    throw new TypeError('Tool result is not JSON-serializable: ' + error.message);
  }
  return serialized === undefined ? 'null' : serialized;
}
