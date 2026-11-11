import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [cmake, plugin, nativeCpp, nativeChat, app, store, installer, tokenRecovery] = await Promise.all([
  readFile(new URL('../android-native/src/main/cpp/CMakeLists.txt', import.meta.url), 'utf8'),
  readFile(new URL('../android-native/src/main/java/com/axiom/mobile/AxiomModelsPlugin.kt', import.meta.url), 'utf8'),
  readFile(new URL('../android-native/src/main/cpp/axiom_llama.cpp', import.meta.url), 'utf8'),
  readFile(new URL('../src/lib/nativeChat.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/App.jsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/NativeModelStore.jsx', import.meta.url), 'utf8'),
  readFile(new URL('../scripts/install-android-native.mjs', import.meta.url), 'utf8'),
  readFile(new URL('../gateway/show-token.mjs', import.meta.url), 'utf8')
]);

test('Android inference builds pinned llama.cpp with Vulkan acceleration and CPU fallback', () => {
  assert.match(cmake, /GIT_TAG b12248/);
  assert.match(cmake, /GGML_NATIVE OFF/);
  assert.match(cmake, /GGML_CPU_KLEIDIAI ON/);
  assert.match(cmake, /GGML_VULKAN ON/);
  assert.match(cmake, /SPIRV_HEADERS_CMAKE_DIR/);
  assert.match(cmake, /LLAMA_BUILD_SERVER OFF/);
  assert.match(cmake, /add_library\(axiompty SHARED axiompty\.cpp axiom_llama\.cpp\)/);
});

test('native model files stay in private storage and use resumable verified installation', () => {
  assert.match(plugin, /File\(context\.filesDir, "models"\)/);
  assert.match(plugin, /setRequestProperty\("Range", range\)/);
  assert.match(plugin, /HTTP_REQUESTED_RANGE_NOT_SATISFIABLE/);
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
});

test('native chat keeps Axiom tool execution behind the existing approval callback', () => {
  assert.match(nativeChat, /confirmTool\(call\.name, args/);
  assert.match(nativeChat, /executeTool\(call\.name, args/);
  assert.match(nativeChat, /cancelNativeGeneration/);
  assert.match(app, /nativeLoadedModel\?runNativeToolChat:runOllamaToolChat/);
  assert.match(app, /confirmTool:/);
  assert.match(app, /runNativeValidation/);
  assert.match(app, /axiom\.onboarding\.v2\.dismissed/);
  assert.match(app, /gateway:token/);
  assert.match(app, /prints the existing private token once in your terminal/);
});

test('Android model store supports HF file inspection, installation, activation and deletion', () => {
  assert.match(store, /Inspect GGUF files/);
  assert.match(store, /Download into Axiom/);
  assert.match(store, /onLoad\(model\.id, Number\(contextSize\)\)/);
  assert.match(store, /onDelete\(model\.id\)/);
  assert.match(store, /Hugging Face authentication/);
  assert.match(store, /Run device validation/);
  assert.match(store, /vulkanDeviceAvailable/);
  assert.match(store, /requestedGpuLayers/);
  assert.match(store, /samples every 1\.5 seconds/);
  assert.match(app, /setInterval\(\(\)=>\{void captureTelemetry\(\)\.catch\(\)\},1500\)/);
  assert.match(app, /text-slate-700 hover:text-slate-950/);
  assert.match(installer, /registerPlugin\(AxiomModelsPlugin\.class\)/);
});


test('first-run onboarding can be reopened and missed gateway tokens can be recovered safely', () => {
  assert.match(app, /axiom\.onboarding\.v2\.dismissed/);
  assert.match(app, /Open setup guide/);
  assert.match(app, /gateway:token/);
  assert.match(tokenRecovery, /\.config.*axiom.*gateway-token/);
  assert.match(tokenRecovery, /process\.stdout\.write/);
  assert.doesNotMatch(tokenRecovery, /writeFile|randomBytes/);
});
