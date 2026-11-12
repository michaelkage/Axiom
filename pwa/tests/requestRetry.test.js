import test from 'node:test';
import assert from 'node:assert/strict';
import { requestWithRetry } from '../src/lib/requestRetry.js';

test('retries transient HTTP failures before returning a successful response', async () => {
  let calls = 0;
  const retries = [];
  const response = await requestWithRetry(async () => {
    calls += 1;
    return calls === 1 ? new Response('busy', { status: 503 }) : new Response('ok', { status: 200 });
  }, '/api/chat', { method: 'POST' }, { retries: 2, baseDelayMs: 0, onRetry: event => retries.push(event) });
  assert.equal(response.status, 200);
  assert.equal(calls, 2);
  assert.equal(retries.length, 1);
  assert.equal(retries[0].attempt, 1);
});

test('does not retry permanent client errors', async () => {
  let calls = 0;
  const response = await requestWithRetry(async () => {
    calls += 1;
    return new Response('bad request', { status: 400 });
  }, '/api/chat', {}, { retries: 3, baseDelayMs: 0 });
  assert.equal(response.status, 400);
  assert.equal(calls, 1);
});

test('retries transient network TypeErrors within the configured bound', async () => {
  let calls = 0;
  const response = await requestWithRetry(async () => {
    calls += 1;
    if (calls < 3) throw new TypeError('network disconnected');
    return new Response('ok');
  }, '/api/chat', {}, { retries: 2, baseDelayMs: 0 });
  assert.equal(response.status, 200);
  assert.equal(calls, 3);
});

test('aborting a backoff wait stops retries immediately', async () => {
  const controller = new AbortController();
  const pending = requestWithRetry(async () => new Response('busy', { status: 503 }), '/api/chat', {}, {
    retries: 3,
    baseDelayMs: 1000,
    signal: controller.signal
  });
  setTimeout(() => controller.abort(new DOMException('Stopped', 'AbortError')), 5);
  await assert.rejects(pending, error => error.name === 'AbortError');
});
