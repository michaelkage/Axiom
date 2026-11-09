import test from 'node:test';
import assert from 'node:assert/strict';
import { consumeNdjsonStream } from '../src/lib/ndjson.js';

test('parses records split across chunks and flushes a final line without newline', async () => {
  const encoder = new TextEncoder();
  const chunks = [
    encoder.encode('{"response":"hel'),
    encoder.encode('lo"}\n{"response":"world"}')
  ];
  const body = new ReadableStream({
    pull(controller) {
      if (chunks.length) controller.enqueue(chunks.shift());
      else controller.close();
    }
  });
  const records = [];
  await consumeNdjsonStream(new Response(body), record => records.push(record));
  assert.deepEqual(records, [{ response: 'hello' }, { response: 'world' }]);
});

test('preserves UTF-8 characters split between byte chunks', async () => {
  const bytes = new TextEncoder().encode('{"response":"café 🌍"}\n');
  const split = bytes.indexOf(0xc3) + 1;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.slice(0, split));
      controller.enqueue(bytes.slice(split));
      controller.close();
    }
  });
  const records = [];
  await consumeNdjsonStream(new Response(body), record => records.push(record));
  assert.deepEqual(records, [{ response: 'café 🌍' }]);
});

test('awaits record handlers in stream order', async () => {
  const response = new Response('{"n":1}\n{"n":2}\n');
  const seen = [];
  await consumeNdjsonStream(response, async record => {
    await Promise.resolve();
    seen.push(record.n);
  });
  assert.deepEqual(seen, [1, 2]);
});

test('reports malformed records with their line number', async () => {
  await assert.rejects(
    consumeNdjsonStream(new Response('{"ok":true}\nnot-json\n'), () => {}),
    /Invalid NDJSON on line 2/
  );
});

test('rejects responses without a readable body', async () => {
  await assert.rejects(
    consumeNdjsonStream({ body: null }, () => {}),
    /Streaming response body unavailable/
  );
});
