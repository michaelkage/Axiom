import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);

test('iOS native bridge implements Keychain, document picker, speech and shared-file handoff', async () => {
  const plugin = await readFile(new URL('ios-native/AxiomIOSPlugin.swift', root), 'utf8');
  for (const method of ['func get(', 'func set(', 'func remove(', 'func pickDocuments(', 'func consumeSharedPayload(', 'func startSpeech(', 'func stopSpeech(']) {
    assert.ok(plugin.includes(method), 'Missing native method: ' + method);
  }
  assert.match(plugin, /kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly/);
  assert.match(plugin, /1_048_576/);
});

test('iOS Share Extension uses the shared app group and supports text, URLs and files', async () => {
  const extensionSource = await readFile(new URL('ios-native/AxiomShareViewController.swift', root), 'utf8');
  const info = await readFile(new URL('ios-native/Share-Info.plist', root), 'utf8');
  assert.match(extensionSource, /group\.com\.axiom\.mobile/);
  assert.match(extensionSource, /AxiomSharedPayload\.json/);
  assert.match(info, /NSExtensionActivationSupportsText/);
  assert.match(info, /NSExtensionActivationSupportsWebURLWithMaxCount/);
  assert.match(info, /NSExtensionActivationSupportsFileWithMaxCount/);
});

test('iOS workflow generates the Capacitor project and configures native targets before compiling', async () => {
  const workflow = await readFile(new URL('../../.github/workflows/ios-testflight.yml', root), 'utf8');
  assert.match(workflow, /npx cap add ios/);
  assert.match(workflow, /npm run ios:configure/);
  assert.match(workflow, /generic\/platform=iOS Simulator/);
  assert.match(workflow, /Upload build to TestFlight/);
});
