import { createClient } from '@supabase/supabase-js';
import { registerTool } from './toolRegistry.js';

export function registerSupabaseTools({ url, key }) {
  if (!url || !key) throw new Error('A Supabase project URL and API key are required.');
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const unregister = [];
  unregister.push(registerTool({
    name: 'supabase_list_tables',
    description: 'Inspect tables exposed through the Supabase REST OpenAPI document.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  }, async () => {
    const response = await fetch(url.replace(/\/$/, '') + '/rest/v1/', { headers: { apikey: key, Authorization: 'Bearer ' + key } });
    if (!response.ok) throw new Error('Supabase schema request failed: HTTP ' + response.status);
    const spec = await response.json();
    return Object.entries(spec.paths || {}).filter(([path]) => path !== '/').map(([path, methods]) => ({
      table: path.replace(/^\//, ''), methods: Object.keys(methods || {})
    }));
  }));
  unregister.push(registerTool({
    name: 'supabase_select_rows',
    description: 'Read rows from a table exposed by the Supabase REST API.',
    inputSchema: { type: 'object', properties: { table: { type: 'string', minLength: 1 }, limit: { type: 'integer' } }, required: ['table'], additionalProperties: false }
  }, async ({ table, limit = 25 }) => {
    if (!/^[a-zA-Z0-9_]+$/.test(table)) throw new Error('Invalid table name.');
    const { data, error } = await client.from(table).select('*').limit(Math.min(Math.max(limit, 1), 100));
    if (error) throw error;
    return data;
  }));
  unregister.push(registerTool({
    name: 'supabase_execute_sql',
    description: 'Execute SQL through a project-defined, permission-controlled RPC named exec_sql. This RPC must be created by the project owner.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1 } }, required: ['query'], additionalProperties: false }
  }, async ({ query }) => {
    const { data, error } = await client.rpc('exec_sql', { query });
    if (error) throw new Error('SQL RPC unavailable or rejected: ' + error.message);
    return data;
  }));
  return () => unregister.forEach(fn => fn());
}
