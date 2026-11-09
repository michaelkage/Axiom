const PROTOCOL_VERSION = '2025-03-26';
export async function connectMcpHttp(endpoint, { fetchImpl = fetch } = {}) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  const call = async (method, params = {}, id = Date.now()) => {
    const response = await fetchImpl(endpoint, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', ...(method.startsWith('notifications/') ? {} : { id }), method, params }) });
    if (!response.ok) throw new Error('MCP HTTP ' + response.status);
    const sessionId = response.headers.get('mcp-session-id');
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;
    const text = await response.text();
    const dataLine = text.split(/\r?\n/).find(line => line.startsWith('data:'));
    const payload = text.trim().startsWith('data:') ? dataLine?.slice(5).trim() : text;
    if (!payload) throw new Error('MCP server returned no JSON-RPC response.');
    const message = JSON.parse(payload);
    if (message.error) throw new Error(message.error.message || 'MCP request failed');
    return message.result;
  };
  await call('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'Axiom', version: '1.0.0' } }, 1);
  await call('notifications/initialized', {}).catch(() => null);
  headers['MCP-Protocol-Version'] = PROTOCOL_VERSION;
  const result = await call('tools/list', {}, 3);
  return { tools: result?.tools || [], call };
}
