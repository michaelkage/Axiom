import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const app = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');

test('chat selects native or Ollama conversation runtime without losing message context', () => {
  assert.match(app, /const chatRunner=nativeLoadedModel\?runNativeToolChat:runOllamaToolChat/);
  assert.match(app, /runOllamaToolChat/);
  assert.match(app, /runNativeToolChat/);
  assert.match(app, /messages:\[\.\.\.priorMessages,userMsg\]/);
  assert.match(app, /tools:availableTools/);
  assert.doesNotMatch(app, /\/api\/generate/);
});

test('chat runtime receives tool execution, cancellation and streamed UI callbacks', () => {
  assert.match(app, /signal,\s*executeTool,\s*serializeToolResult/);
  assert.match(app, /onText:value=>\{answer=value;if\(streamTimerRef\.current===null\)streamTimerRef\.current=setTimeout/);
  assert.match(app, /clearTimeout\(streamTimerRef\.current\)/);
  assert.match(app, /onEvent:event=>/);
  assert.match(app, /Permission required/);
  assert.match(app, /Approve tool execution/);
  assert.match(app, /Allow once/);
  assert.match(app, /confirmTool:\(name,args/);
});

test('stream rendering, persistence and prompt context are bounded for mobile devices', () => {
  assert.match(app, /setTimeout\(\(\)=>\{const settings=/);
  assert.match(app, /const priorMessages=\(currentChat\?\.messages\|\|\[\]\)\.slice\(-12\)/);
});

test('partial output and cancellation are retained against the originating chat', () => {
  assert.match(app, /patchChat\(old=>old\.map\(m=>m\.id===assistantId\?\{\.\.\.m,content:answer\}:m\),chatId\)/);
  assert.match(app, /Generation cancelled/);
  assert.match(app, /Partial assistant output was preserved/);
});


test('successful Ollama model pulls select the downloaded model for the next chat', () => {
  assert.match(app, /update\(\{model\}\);\s*log\('success','Model installed and selected'/);
  assert.match(app, /Model installed and selected for chat:/);
});

test('provider credentials are entered in app settings and saved through the authenticated gateway', () => {
  assert.match(app, /id="github-pat"/);
  assert.match(app, /id="github-repository"/);
  assert.match(app, /id="supabase-project-url"/);
  assert.match(app, /id="supabase-publishable-key"/);
  assert.match(app, /provider-config/);
  assert.match(app, /Provider secrets require an HTTPS gateway/);
  assert.match(app, /Tools registered:/);
  assert.match(app, /diagnostics\?\.services\?\.\[id\]\?\.status!=='connected'/);
});
