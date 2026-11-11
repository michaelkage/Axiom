import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [cmake, plugin, nativeCpp, nativeChat, app, store, installer, tokenRecovery, runtimePlugin, runtimeBridge, termuxSetup, runtimeControls] = await Promise.all([
  readFile(new URL('../android-native/src/main/cpp/CMakeLists.txt', import.meta.url), 'utf8'),
  readFile(new URL('../android-native/src/main/java/com/axiom/mobile/AxiomModelsPlugin.kt', import.meta.url), 'utf8'),
  readFile(new URL('../android-native/src/main/cpp/axiom_llama.cpp', import.meta.url), 'utf8'),
  readFile(new URL('../src/lib/nativeChat.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/App.jsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/NativeModelStore.jsx', import.meta.url), 'utf8'),
  readFile(new URL('../scripts/install-android-native.mjs', import.meta.url), 'utf8'),
  readFile(new URL('../gateway/show-token.mjs', import.meta.url), 'utf8'),
  readFile(new URL('../android-native/src/main/java/com/axiom/mobile/AxiomRuntimePlugin.kt', import.meta.url), 'utf8'),
  readFile(new URL('../src/lib/axiomRuntime.js', import.meta.url), 'utf8'),
  readFile(new URL('../scripts/setup-termux-ollama.sh', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/RuntimeControls.jsx', import.meta.url), 'utf8')
]);

test('Android inference builds pinned llama.cpp with Vulkan acceleration and CPU fallback', () => {
  assert.match(cmake, /GIT_TAG b12248/);
  assert.match(cmake, /GGML_NATIVE OFF/);
  assert.match(cmake, /GGML_CPU_KLEIDIAI ON/);
  assert.ok(cmake.includes("set(AXIOM_ENABLE_VULKAN ON)"));
  assert.ok(cmake.includes('STREQUAL "0"'));
  assert.ok(cmake.includes('set(GGML_VULKAN ${AXIOM_ENABLE_VULKAN} CACHE BOOL "" FORCE)'));
  assert.match(cmake, /SPIRV_HEADERS_CMAKE_DIR/);
  assert.match(cmake, /LLAMA_BUILD_SERVER OFF/);
  assert.match(cmake, /add_library\(axiompty SHARED axiompty\.cpp axiom_llama\.cpp\)/);
});

test('native model files stay in private storage and use resumable verified installation', () => {
  assert.match(plugin, /File\(context\.filesDir, "models"\)/);
  assert.match(plugin, /setRequestProperty\("Range", it\)/);
  assert.match(plugin, /status == 416/);
  assert.match(plugin, /activeDownloads\.putIfAbsent/);
  assert.match(plugin, /identityHash/);
  assert.match(plugin, /Never forward the Hub credential to a signed CDN redirect/);
  assert.match(plugin, /MessageDigest\.getInstance\("SHA-256"\)/);
  assert.match(plugin, /android\.system\.Os\.rename\(partial\.absolutePath, target\.absolutePath\)/);
  assert.match(plugin, /expectedSha\.isNotEmpty\(\).*digest\.equals/);
  assert.match(plugin, /fun cancelModelDownload/);
  assert.match(plugin, /fun deleteLocalModel/);
});

test('native inference exposes model lifecycle, chat-template JNI and cancellation', () => {
  assert.match(plugin, /fun importLocalModel/);
  assert.match(plugin, /Intent\(Intent\.ACTION_OPEN_DOCUMENT\)/);
  assert.match(plugin, /OpenableColumns\.DISPLAY_NAME/);
  assert.match(plugin, /fun loadLocalModel/);
  assert.match(plugin, /fun unloadLocalModel/);
  assert.match(plugin, /fun generateLocal/);
  assert.match(plugin, /fun cancelLocalGeneration/);
  assert.match(plugin, /fun setHuggingFaceToken/);
  assert.match(plugin, /fun clearHuggingFaceToken/);
  assert.match(plugin, /AndroidKeyStore/);
  assert.match(plugin, /Authorization", "Bearer/);
  assert.match(plugin, /batteryTemperatureC/);
  assert.match(plugin, /thermalStatus/);
  assert.match(plugin, /processPssBytes/);
  assert.match(nativeCpp, /llama_model_chat_template/);
  assert.match(nativeCpp, /llama_chat_apply_template/);
  assert.match(nativeCpp, /llama_sampler_sample/);
  assert.match(nativeCpp, /isCancelled/);
  assert.match(nativeCpp, /valid_utf8_prefix/);
  assert.match(nativeCpp, /model_params\.n_gpu_layers = gpu_layer_count/);
  assert.match(nativeCpp, /retrying with CPU-only inference/);
  assert.match(nativeCpp, /if \(!g_context\)/);
  assert.match(nativeCpp, /if \(!load_model_and_context\(0\)\)/);
  assert.match(nativeCpp, /llama_supports_gpu_offload/);
  assert.match(nativeCpp, /vkEnumeratePhysicalDevices/);
  assert.ok(cmake.includes('find_library(AXIOM_ANDROID_VULKAN_LIBRARY vulkan REQUIRED)'));
  assert.ok(cmake.includes('target_link_libraries(axiompty PRIVATE llama ggml android log dl ${AXIOM_ANDROID_VULKAN_LIBRARY})'));
});

test('native chat keeps Axiom tool execution behind the existing approval callback', () => {
  assert.match(nativeChat, /confirmTool\(call\.name, args/);
  assert.match(nativeChat, /executeTool\(call\.name, args/);
  assert.match(nativeChat, /cancelNativeGeneration/);
  assert.match(app, /nativeLoadedModel\?runNativeToolChat:runOllamaToolChat/);
  assert.match(app, /importNativeModelFile/);
  assert.match(app, /ollamaConnectionMode/);
  assert.match(app, /No models installed/);
  assert.match(app, /confirmTool:/);
  assert.match(app, /runNativeValidation/);
  assert.match(app, /axiom\.onboarding\.v2\.dismissed/);
  assert.match(app, /consumeGatewayPairingIntent/);
  assert.match(app, /Gateway paired automatically/);
  assert.doesNotMatch(app, /Paste AXIOM_GATEWAY_TOKEN/);
});


test('Termux pairing securely hands a local gateway credential to Android without a token URI', () => {
  assert.ok(runtimePlugin.includes('fun consumeGatewayPairingIntent'));
  assert.ok(runtimePlugin.includes('com.axiom.mobile.GATEWAY_PAIR'));
  assert.ok(runtimePlugin.includes('getStringExtra("axiom_gateway_token")'));
  assert.ok(runtimePlugin.includes('setIntent(Intent(activity, activity.javaClass)'));
  assert.ok(runtimePlugin.includes('AndroidKeyStore'));
  assert.ok(runtimePlugin.includes('validatedGatewayUrl'));
  assert.ok(runtimePlugin.includes('instanceFollowRedirects = false'));
  assert.ok(runtimeBridge.includes('consumeGatewayPairingIntent(gatewayUrl)'));
  assert.ok(termuxSetup.includes('am start -n com.axiom.mobile/.MainActivity -a com.axiom.mobile.GATEWAY_PAIR --es axiom_gateway_token'));
  assert.equal(termuxSetup.includes('axiom://gateway-pair'), false);
  assert.equal(termuxSetup.includes('gateway:token'), false);
  assert.ok(runtimeControls.includes('Automatic gateway pairing'));
  assert.ok(runtimeControls.includes('Advanced: pair a gateway on another device'));
  assert.equal(runtimeControls.includes('Recover the gateway pairing token'), false);
});

test('Android model store supports HF file inspection, installation, activation and deletion', () => {
  assert.match(store, /Import \.gguf/);
  assert.match(store, /native-ollama-url/);
  assert.match(store, /Connect and discover server models/);
  assert.match(store, /No native models installed/);
  assert.match(store, /Inspect GGUF files/);
  assert.match(store, /Download into Axiom/);
  assert.match(store, /onLoad\(model\.id, Number\(contextSize\)\)/);
  assert.match(store, /onDelete\(model\.id\)/);
  assert.match(store, /Hugging Face authentication/);
  assert.match(store, /Run device validation/);
  assert.match(store, /vulkanDeviceAvailable/);
  assert.match(store, /requestedGpuLayers/);
  assert.match(store, /about every 1\.5 seconds/);
  assert.match(app, /setInterval\(\(\)=>\{void captureTelemetry/);
  assert.match(app, /text-slate-700 hover:text-slate-950/);
  assert.match(installer, /registerPlugin\(AxiomModelsPlugin\.class\)/);
  assert.ok(installer.includes('versionCode\\s+\\d+'));
  assert.ok(installer.includes('versionName\\s+'));
});


test('first-run onboarding can be reopened and explains automatic gateway pairing', () => {
  assert.match(app, /axiom\.onboarding\.v2\.dismissed/);
  assert.match(app, /Open setup guide/);
  assert.match(app, /Connect the local gateway automatically/);
  assert.match(app, /setup-termux-ollama\.sh/);
  assert.match(app, /No copying, pasting, or token screen/);
  assert.doesNotMatch(app, /gateway:token/);
  assert.match(tokenRecovery, /\.config.*axiom.*gateway-token/);
  assert.match(tokenRecovery, /process\.stdout\.write/);
  assert.doesNotMatch(tokenRecovery, /writeFile|randomBytes/);
});
