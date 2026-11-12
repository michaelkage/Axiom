import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_ATTACHMENT_BYTES, MAX_TOTAL_ATTACHMENT_BYTES, buildAttachmentPrompt, buildOutcomeSummary } from '../src/lib/workspaceCapture.js';

test('attachment cap matches the one MiB workspace limit', () => {
  assert.equal(MAX_ATTACHMENT_BYTES, 1024 * 1024);
  assert.equal(MAX_TOTAL_ATTACHMENT_BYTES, 1024 * 1024);
});

test('attachment prompt includes text content and image labels without embedding image data URLs', () => {
  const prompt = buildAttachmentPrompt([
    { kind: 'text', name: 'notes.md', type: 'text/markdown', text: '# Notes' },
    { kind: 'image', name: 'screen.jpg', type: 'image/jpeg', base64: 'private-image-bytes' }
  ]);
  assert.match(prompt, /FILE: notes\.md/);
  assert.match(prompt, /# Notes/);
  assert.match(prompt, /Attached image: screen\.jpg/);
  assert.doesNotMatch(prompt, /private-image-bytes/);
});

test('outcome summary reports changed files and explicit verification without inventing results', () => {
  const summary = buildOutcomeSummary([
    { role: 'user', content: 'Please update pwa/src/App.jsx and run tests.' },
    { role: 'assistant', content: 'Implemented the theme switcher and updated pwa/src/App.jsx. Build passed.' }
  ], []);
  assert.match(summary, /What Changed/);
  assert.match(summary, /Files Touched/);
  assert.match(summary, /pwa\/src\/App\.jsx/);
  assert.match(summary, /Verification Status/);
  assert.match(summary, /Remaining Next Steps/);
  assert.match(summary, /Successful checks are mentioned/);
});

test('outcome summary clearly marks missing verification as unknown', () => {
  const summary = buildOutcomeSummary([{ role: 'user', content: 'Update a component.' }, { role: 'assistant', content: 'Updated the component.' }], []);
  assert.match(summary, /No explicit verification result was found/);
});

test('user claims alone do not count as verification evidence', () => {
  const summary = buildOutcomeSummary([
    { role: 'user', content: 'The build passed, please review it.' },
    { role: 'assistant', content: 'Updated the requested component.' }
  ], []);
  assert.match(summary, /No explicit verification result was found/);
});

test('user-requested paths are not reported as touched without implementation evidence', () => {
  const summary = buildOutcomeSummary([
    { role: 'user', content: 'Please update src/only-requested.js.' },
    { role: 'assistant', content: 'I reviewed the request but made no changes.' }
  ], []);
  assert.match(summary, /No file paths were identified/);
});
