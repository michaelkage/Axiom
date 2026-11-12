import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [manifestText, worker, html, entry, app, modelStore, nativeModelStore] = await Promise.all([
  readFile(new URL('../public/manifest.webmanifest', import.meta.url), 'utf8'),
  readFile(new URL('../public/sw.js', import.meta.url), 'utf8'),
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
  readFile(new URL('../src/main.jsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/App.jsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/ModelStore.jsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/NativeModelStore.jsx', import.meta.url), 'utf8')
]);
const [codeEditor, skillsMarketplace, skillRegistry, workspaceCapture] = await Promise.all([
  readFile(new URL('../src/components/CodeEditor.jsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/SkillsMarketplace.jsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/lib/skillRegistry.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/lib/workspaceCapture.js', import.meta.url), 'utf8')
]);

const manifest = JSON.parse(manifestText);

test('workspace editor provides import, syntax highlighting, find/replace, save and revert', () => {
  assert.match(app, /tab==='workspace'/);
  assert.match(codeEditor, /HighlightedCode/);
  assert.match(codeEditor, /Replace next/);
  assert.match(codeEditor, /Replace all/);
  assert.match(codeEditor, /showSaveFilePicker/);
  assert.match(codeEditor, /setValue\(original\)/);
  assert.match(codeEditor, /1024 \* 1024/);
});

test('skills marketplace inspects manifests and exposes per-task activation', () => {
  assert.match(app, /tab==='skills'/);
  assert.match(app, /skillIds/);
  assert.match(skillsMarketplace, /Read full SKILL\.md instructions/);
  assert.match(skillsMarketplace, /Activate .* for this task/);
  assert.match(skillRegistry, /validateSkillManifest/);
  assert.match(skillRegistry, /MAX_INSTRUCTIONS_CHARS/);
});

test('PWA manifest declares a standalone, portrait-first mobile app', () => {
  assert.equal(manifest.name, 'Axiom AI Command Center');
  assert.equal(manifest.short_name, 'Axiom');
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.orientation, 'portrait-primary');
  assert.ok(manifest.icons.some(icon => icon.src === '/axiom.svg' && icon.purpose.includes('maskable')));
});

test('manifest registers a multipart Web Share Target for text, URLs and project files', () => {
  assert.equal(manifest.share_target.action, '/share');
  assert.equal(manifest.share_target.method, 'POST');
  assert.equal(manifest.share_target.enctype, 'multipart/form-data');
  assert.equal(manifest.share_target.params.text, 'text');
  assert.ok(manifest.share_target.params.files.some(file => file.name === 'files' && file.accept.includes('image/*')));
  assert.match(worker, /request\.formData\(\)/);
  assert.match(worker, /axiom-share-target/);
  assert.match(worker, /Response\.redirect\(new URL\('\/?\?shared=1'/);
});

test('mobile workspace exposes voice, attachments, theme controls, retries and summaries', () => {
  assert.match(app, /VoiceCapture/);
  assert.match(app, /prepareAttachments/);
  assert.match(workspaceCapture, /MAX_ATTACHMENT_BYTES/);
  assert.match(app, /axiom-theme/);
  assert.match(app, /axiom-accent/);
  assert.match(app, /axiom-retries/);
  assert.match(app, /buildOutcomeSummary/);
  assert.match(app, /bootStatus/);
});

test('document exposes install metadata and a viewport that supports display cutouts', () => {
  assert.match(html, /name="viewport"[^>]*viewport-fit=cover/);
  assert.match(html, /name="theme-color"/);
  assert.match(html, /rel="manifest" href="\/manifest\.webmanifest"/);
  assert.match(entry, /navigator\.serviceWorker\.register\('\/sw\.js'\)/);
});

test('service worker precaches the app shell and removes obsolete cache versions', () => {
  assert.match(worker, /const CACHE = 'axiom-shell-v\d+'/);
  assert.match(worker, /const SHELL = \['\/', '\/index\.html', '\/manifest\.webmanifest', '\/axiom\.svg', '\/skills\/registry\.json'\]/);
  assert.match(worker, /keys\.filter\(key => key !== CACHE\)/);
  assert.match(worker, /cache\.addAll\(SHELL\)/);
});

test('service worker limits caching to same-origin GET app resources', () => {
  assert.match(worker, /request\.method !== 'GET'/);
  assert.match(worker, /new URL\(request\.url\)\.origin !== self\.location\.origin/);
  assert.match(worker, /url\.pathname === '\/skills\/registry\.json'/);
  assert.match(worker, /url\.pathname\.startsWith\('\/assets\/'\)/);
  assert.match(worker, /if \(!isNavigation && !isStaticAsset\) return/);
});

test('offline navigation falls back to the cached application document', () => {
  assert.match(worker, /const response = await fetch\(request\)/);
  assert.match(worker, /return \(await caches\.match\('\/index\.html'\)\) \|\| Response\.error\(\)/);
  assert.match(worker, /cache\.put\('\/index\.html', response\.clone\(\)\)/);
});


test('chat never assumes a model that the runtime has not confirmed installed', () => {
  assert.match(app, /model:''/);
  assert.match(app, /models\.includes\(state\.model\)/);
  assert.match(app, /No models installed/);
  assert.match(app, /!nativeLoadedModel&&!selectedOllamaModel/);
  assert.match(app, /disabled=\{\(!draft\.trim\(\)&&!draftAttachments\.length\)\|\|!activeModel\}/);
  assert.doesNotMatch(app, /model:'qwen2\.5:1\.5b'/);
  assert.doesNotMatch(app, /aria-label="Default model"/);
});

test('model stores do not preselect or prefill a phantom Qwen model', () => {
  assert.match(modelStore, /No models installed\. Connect a model server or install a model below to start chatting\./);
  assert.match(modelStore, /Cannot read the model library/);
  assert.match(nativeModelStore, /useState\(''\)/);
  assert.doesNotMatch(nativeModelStore, /useState\('Qwen2\.5 1\.5B GGUF'\)/);
});
