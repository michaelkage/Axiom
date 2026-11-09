import { createClient } from '@supabase/supabase-js';
import { registerTool } from './toolRegistry.js';

export function registerSupabaseTools({ url, key }) {
  if (!url || !key) throw new Error('A Supabase project URL and API key are required.');
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const unregister = [];
  unregister.push(registerTool({
    name: 'supabase_list_tables',
    description: 'List public tables through a project-defined, permission-controlled exec_sql RPC.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  }, async () => {
    const { data, error } = await client.rpc('exec_sql', { query: "select table_schema, table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name" });
    if (error) throw new Error('Table discovery requires a project-owned, permission-controlled exec_sql RPC: ' + error.message);
    return data;
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
    name: 'supabase_describe_table',
    description: 'Inspect column names and data types for a public table through the configured permission-controlled exec_sql RPC.',
    inputSchema: { type: 'object', properties: { table: { type: 'string', minLength: 1 } }, required: ['table'], additionalProperties: false }
  }, async ({ table }) => {
    if (!/^[a-zA-Z0-9_]+$/.test(table)) throw new Error('Invalid table name.');
    const query = "select column_name, data_type, is_nullable, ordinal_position from information_schema.columns where table_schema = 'public' and table_name = '" + table + "' order by ordinal_position";
    const { data, error } = await client.rpc('exec_sql', { query });
    if (error) throw new Error('Schema inspection requires a project-owned, permission-controlled exec_sql RPC: ' + error.message);
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
