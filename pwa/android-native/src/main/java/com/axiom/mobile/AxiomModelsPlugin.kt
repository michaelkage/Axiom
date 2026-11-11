package com.axiom.mobile

import android.app.ActivityManager
import android.os.StatFs
import android.os.Debug
import android.os.BatteryManager
import android.os.PowerManager
import android.content.Intent
import android.content.IntentFilter
import android.provider.OpenableColumns
import com.getcapacitor.ActivityResult
import android.util.Base64
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import com.getcapacitor.*
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.security.MessageDigest
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean

@CapacitorPlugin(name = "AxiomModels")
class AxiomModelsPlugin : Plugin() {
    private val modelRoot: File by lazy { File(context.filesDir, "models").apply { mkdirs() }.canonicalFile }
    private val activeDownloads = ConcurrentHashMap<String, AtomicBoolean>()
    private val hfPrefs by lazy { context.getSharedPreferences("axiom_models_secure", android.content.Context.MODE_PRIVATE) }
    private val generationCancelled = AtomicBoolean(false)
    private val generationActive = AtomicBoolean(false)

    private external fun llamaLoadModel(path: String, contextSize: Int, threads: Int, gpuLayers: Int): Boolean
    private external fun llamaLoadedGpuLayers(): Int
    private external fun llamaUnloadModel()
    private external fun llamaLoadedModel(): String
    private external fun llamaGenerate(roles: Array<String>, contents: Array<String>, maxTokens: Int, callback: Any): String
    private external fun isVulkanAvailable(): Boolean
    private external fun vulkanDeviceName(): String
    private external fun gpuOffloadSupported(): Boolean

    override fun load() {
        super.load()
        System.loadLibrary("axiompty")
    }

    @PluginMethod
    fun getDeviceCapabilities(call: PluginCall) {
        val memory = ActivityManager.MemoryInfo()
        (context.getSystemService(android.content.Context.ACTIVITY_SERVICE) as ActivityManager).getMemoryInfo(memory)
        val stat = StatFs(modelRoot.absolutePath)
        val processMemory = Debug.MemoryInfo()
        Debug.getMemoryInfo(processMemory)
        val battery = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val batteryTemperature = battery?.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, -1)?.takeIf { it >= 0 }?.div(10.0)
        val thermalStatus = if (android.os.Build.VERSION.SDK_INT >= 29) (context.getSystemService(android.content.Context.POWER_SERVICE) as PowerManager).currentThermalStatus else -1
        val thermalLabel = when (thermalStatus) { 0 -> "none"; 1 -> "light"; 2 -> "moderate"; 3 -> "severe"; 4 -> "critical"; 5 -> "emergency"; 6 -> "shutdown"; else -> "unknown" }
        val gpuName = vulkanDeviceName()
        call.resolve(JSObject()
            .put("platform", "android")
            .put("abis", JSArray().apply { android.os.Build.SUPPORTED_ABIS.forEach { put(it) } })
            .put("primaryAbi", android.os.Build.SUPPORTED_ABIS.firstOrNull() ?: "unknown")
            .put("cpuCores", Runtime.getRuntime().availableProcessors())
            .put("totalRamBytes", memory.totalMem)
            .put("availableRamBytes", memory.availMem)
            .put("lowMemory", memory.lowMemory)
            .put("processPssBytes", processMemory.totalPss.toLong() * 1024L)
            .put("batteryTemperatureC", batteryTemperature)
            .put("thermalStatus", thermalLabel)
            .put("gpuOffloadSupported", gpuOffloadSupported())
            .put("requestedGpuLayers", llamaLoadedGpuLayers())
            .put("storageAvailableBytes", stat.availableBytes)
            .put("storageTotalBytes", stat.totalBytes)
            .put("vulkanLoaderAvailable", isVulkanAvailable())
            .put("vulkanDeviceAvailable", gpuName.isNotBlank())
            .put("vulkanDeviceName", gpuName)
            .put("inferenceBackend", if (gpuOffloadSupported() && gpuName.isNotBlank()) "llama.cpp Vulkan + CPU fallback" else "llama.cpp CPU")
            .put("loadedModel", llamaLoadedModel().takeIf { it.isNotBlank() }?.let { File(it).name } ?: ""))
    }

    @PluginMethod
    fun listLocalModels(call: PluginCall) {
        val result = JSArray()
        modelRoot.listFiles()?.filter { it.isFile && it.name.endsWith(".gguf", true) }?.sortedBy { it.name }?.forEach { file ->
            val metadataFile = File(modelRoot, file.name + ".json")
            val metadata = try { if (metadataFile.isFile) org.json.JSONObject(metadataFile.readText()) else org.json.JSONObject() } catch (_: Exception) { org.json.JSONObject() }
            result.put(JSObject()
                .put("id", file.name)
                .put("name", file.name)
                .put("sizeBytes", file.length())
                .put("sha256", metadata.optString("sha256", "not-verified"))
                .put("sha256Verified", metadata.optBoolean("sha256Verified", false))
                .put("repo", metadata.optString("repo", ""))
                .put("loaded", llamaLoadedModel() == file.absolutePath))
        }
        call.resolve(JSObject().put("models", result))
    }

    @PluginMethod
    fun importLocalModel(call: PluginCall) {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "*/*"
            putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("application/octet-stream", "application/x-gguf", "application/gguf"))
            putExtra(Intent.EXTRA_TITLE, "Choose a GGUF model")
        }
        startActivityForResult(call, intent, "handleLocalModelImport")
    }

    @ActivityCallback
    private fun handleLocalModelImport(call: PluginCall, result: ActivityResult) {
        if (result.resultCode != android.app.Activity.RESULT_OK) {
            call.reject("Model import was cancelled.")
            return
        }
        val uri = result.data?.data ?: run {
            call.reject("The selected file could not be opened.")
            return
        }
        Thread({
            try {
                val displayName = context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
                    if (cursor.moveToFirst()) cursor.getString(0) else null
                } ?: "imported-model.gguf"
                if (!displayName.endsWith(".gguf", true)) {
                    throw IllegalArgumentException("Choose a .gguf model file. A folder or other file type cannot be loaded by the native runtime.")
                }
                val safeName = displayName.substringAfterLast('/').replace(Regex("[^A-Za-z0-9._-]"), "_").take(140)
                val stat = StatFs(modelRoot.absolutePath)
                val available = stat.availableBytes
                val sourceSize = context.contentResolver.openAssetFileDescriptor(uri, "r")?.use { it.length } ?: -1L
                if (sourceSize > 0 && available < sourceSize + 134217728L) {
                    throw IllegalStateException("Not enough private storage for this model file.")
                }
                var target = File(modelRoot, safeName).canonicalFile
                if (target.parentFile != modelRoot) throw IllegalArgumentException("Invalid model filename.")
                if (target.exists()) {
                    val stem = safeName.removeSuffix(".gguf")
                    var suffix = 2
                    do {
                        target = File(modelRoot, stem + "-" + suffix + ".gguf").canonicalFile
                        suffix++
                    } while (target.exists())
                }
                val partial = File(modelRoot, target.name + ".part")
                val digest = MessageDigest.getInstance("SHA-256")
                var copied = 0L
                context.contentResolver.openInputStream(uri)?.use { input ->
                    FileOutputStream(partial).use { output ->
                        val buffer = ByteArray(1048576)
                        while (true) {
                            val count = input.read(buffer)
                            if (count < 0) break
                            output.write(buffer, 0, count)
                            digest.update(buffer, 0, count)
                            copied += count
                            if (copied > available - 134217728L) {
                                throw IllegalStateException("The selected model is larger than the available private storage.")
                            }
                        }
                        output.fd.sync()
                    }
                } ?: throw IllegalStateException("Android could not read the selected model file.")
                if (copied == 0L) throw IllegalStateException("The selected GGUF file is empty.")
                android.system.Os.rename(partial.absolutePath, target.absolutePath)
                val sha = digest.digest().joinToString("") { "%02x".format(it) }
                File(modelRoot, target.name + ".json").writeText(org.json.JSONObject()
                    .put("source", "android-document-picker")
                    .put("sourceName", displayName)
                    .put("sha256", sha)
                    .put("sha256Verified", true)
                    .put("sizeBytes", copied).toString())
                activity.runOnUiThread {
                    call.resolve(JSObject().put("id", target.name).put("name", target.name)
                        .put("sizeBytes", copied).put("sha256", sha).put("sha256Verified", true))
                }
            } catch (error: Exception) {
                File(modelRoot, "import-placeholder.part").delete()
                activity.runOnUiThread { call.reject(error.message ?: "Could not import the GGUF model.") }
            }
        }, "axiom-model-import").apply { isDaemon = true }.start()
    }

    @PluginMethod
    fun getHuggingFaceAuthStatus(call: PluginCall) {
        call.resolve(JSObject().put("configured", runCatching { !getHuggingFaceToken().isNullOrBlank() }.getOrDefault(false)))
    }

    @PluginMethod
    fun setHuggingFaceToken(call: PluginCall) {
        val token = call.getString("token").orEmpty().trim()
        if (token.length !in 16..4096 || token.any { it.isWhitespace() }) return call.reject("Enter a valid Hugging Face read token.")
        try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, getHuggingFaceKey())
            val encrypted = cipher.iv + cipher.doFinal(token.toByteArray(Charsets.UTF_8))
            hfPrefs.edit().putString("hf_token", Base64.encodeToString(encrypted, Base64.NO_WRAP)).apply()
            call.resolve(JSObject().put("configured", true))
        } catch (error: Exception) {
            call.reject(error.message ?: "Could not encrypt the Hugging Face token.")
        }
    }

    @PluginMethod
    fun clearHuggingFaceToken(call: PluginCall) {
        hfPrefs.edit().remove("hf_token").apply()
        call.resolve(JSObject().put("configured", false))
    }

    private fun getHuggingFaceToken(): String? {
        val stored = hfPrefs.getString("hf_token", null) ?: return null
        return try {
            val bytes = Base64.decode(stored, Base64.NO_WRAP)
            require(bytes.size > 12) { "Stored Hugging Face credential is invalid." }
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, getHuggingFaceKey(), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
            String(cipher.doFinal(bytes.copyOfRange(12, bytes.size)), Charsets.UTF_8)
        } catch (error: Exception) {
            throw IllegalStateException("Could not decrypt the saved Hugging Face token. Save it again.", error)
        }
    }

    private fun getHuggingFaceKey(): SecretKey {
        val alias = "axiom.huggingface.read"
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true)
            .build())
        return generator.generateKey()
    }

    private fun openHuggingFaceConnection(url: URL, accept: String? = null, range: String? = null): HttpURLConnection {
        var current = url
        val token = getHuggingFaceToken()
        for (redirect in 0..5) {
            if (current.protocol != "https" || current.userInfo != null) {
                throw IllegalStateException("Hugging Face returned an unsafe download URL.")
            }
            val connection = current.openConnection() as HttpURLConnection
            connection.instanceFollowRedirects = false
            connection.connectTimeout = 15000
            connection.readTimeout = 30000
            accept?.let { connection.setRequestProperty("Accept", it) }
            range?.let { connection.setRequestProperty("Range", it) }
            // Never forward the Hub credential to a signed CDN redirect.
            if (redirect == 0 && current.host.equals("huggingface.co", ignoreCase = true)) {
                token?.let { connection.setRequestProperty("Authorization", "Bearer $it") }
            }
            val status = connection.responseCode
            if (status !in setOf(301, 302, 303, 307, 308)) return connection
            val location = connection.getHeaderField("Location")
                ?: throw IllegalStateException("Hugging Face returned a redirect without a destination.")
            connection.disconnect()
            if (redirect == 5) throw IllegalStateException("Hugging Face exceeded the redirect limit.")
            current = URL(current, location)
        }
        throw IllegalStateException("Could not open the Hugging Face resource.")
    }

    @PluginMethod
    fun getHuggingFaceModelFiles(call: PluginCall) {
        val repo = call.getString("repo").orEmpty()
        if (!repo.matches(Regex("[A-Za-z0-9_.-]{1,96}/[A-Za-z0-9_.-]{1,96}"))) return call.reject("Invalid Hugging Face repository ID.")
        Thread({
            try {
                val connection = openHuggingFaceConnection(URL("https://huggingface.co/api/models/$repo/tree/main?recursive=true&expand=true"), "application/json")
                val status = connection.responseCode
                if (status == 401 || status == 403) throw IllegalStateException("Hugging Face denied access. Save a read token in Axiom and confirm your account has access to this repository.")
                if (status !in 200..299) throw IllegalStateException("Hugging Face returned HTTP $status.")
                val entries = org.json.JSONArray(connection.inputStream.bufferedReader().use { it.readText() })
                val files = JSArray()
                for (i in 0 until entries.length()) {
                    val entry = entries.optJSONObject(i) ?: continue
                    val name = entry.optString("path")
                    if (!name.endsWith(".gguf", true) || entry.optString("type") != "file") continue
                    val oid = entry.optJSONObject("lfs")?.optString("oid").orEmpty().removePrefix("sha256:")
                    files.put(JSObject()
                        .put("path", name)
                        .put("sizeBytes", entry.optLong("size", 0L))
                        .put("sha256", oid.takeIf { it.matches(Regex("[a-fA-F0-9]{64}")) } ?: ""))
                }
                connection.disconnect()
                activity.runOnUiThread { call.resolve(JSObject().put("repo", repo).put("files", files)) }
            } catch (error: Exception) {
                activity.runOnUiThread { call.reject(error.message ?: "Could not list Hugging Face model files.") }
            }
        }, "axiom-hf-files").apply { isDaemon = true }.start()
    }

    @PluginMethod
    fun downloadHuggingFaceModel(call: PluginCall) {
        val repo = call.getString("repo").orEmpty()
        val remotePath = call.getString("file").orEmpty()
        val expectedSha = call.getString("sha256").orEmpty().lowercase(Locale.ROOT)
        val expectedSize = call.getLong("sizeBytes") ?: 0L
        if (!repo.matches(Regex("[A-Za-z0-9_.-]{1,96}/[A-Za-z0-9_.-]{1,96}"))) return call.reject("Invalid Hugging Face repository ID.")
        if (remotePath.isBlank() || remotePath.startsWith("/") || remotePath.split("/").any { it == ".." } || !remotePath.endsWith(".gguf", true)) return call.reject("Invalid GGUF file path.")
        if (expectedSha.isNotEmpty() && !expectedSha.matches(Regex("[a-f0-9]{64}"))) return call.reject("Invalid SHA-256 checksum.")

        val identityHash = MessageDigest.getInstance("SHA-256").digest("$repo/$remotePath".toByteArray(Charsets.UTF_8)).take(8).joinToString("") { "%02x".format(it) }
        val safeRepo = repo.replace("/", "--").replace(Regex("[^A-Za-z0-9._-]"), "_").take(64)
        val safeFile = remotePath.substringAfterLast("/").replace(Regex("[^A-Za-z0-9._-]"), "_").take(100)
        val id = "$safeRepo--$safeFile--$identityHash"
        val target = File(modelRoot, id).canonicalFile
        if (target.parentFile != modelRoot) return call.reject("Model path escaped private storage.")
        val partial = File(modelRoot, "$id.part")
        if (llamaLoadedModel() == target.absolutePath) return call.reject("Unload this model before replacing it.")
        val cancel = AtomicBoolean(false)
        if (activeDownloads.putIfAbsent(id, cancel) != null) return call.reject("This model download is already running.")

        Thread({
            try {
                val stat = StatFs(modelRoot.absolutePath)
                if (expectedSize > 0 && stat.availableBytes < expectedSize + 128L * 1024L * 1024L) {
                    throw IllegalStateException("Not enough free storage. Free at least ${expectedSize + 128L * 1024L * 1024L} bytes before downloading.")
                }
                var existing = if (partial.exists()) partial.length() else 0L
                val encodedPath = remotePath.split("/").joinToString("/") { URLEncoder.encode(it, "UTF-8").replace("+", "%20") }
                val resourceUrl = URL("https://huggingface.co/$repo/resolve/main/$encodedPath?download=true")
                var connection = openHuggingFaceConnection(resourceUrl, range = if (existing > 0) "bytes=$existing-" else null)
                var status = connection.responseCode
                if (status == 416 && existing > 0) {
                    connection.disconnect()
                    partial.delete()
                    existing = 0L
                    connection = openHuggingFaceConnection(resourceUrl)
                    status = connection.responseCode
                }
                if (status == 401 || status == 403) throw IllegalStateException("Hugging Face denied this download. Save a read token and confirm repository access.")
                if (status !in 200..299) throw IllegalStateException("Model download returned HTTP $status.")
                if (existing > 0 && status != HttpURLConnection.HTTP_PARTIAL) {
                    existing = 0L
                    partial.delete()
                }
                val total = if (status == HttpURLConnection.HTTP_PARTIAL) {
                    connection.getHeaderField("Content-Range")?.substringAfterLast("/")?.toLongOrNull() ?: (existing + connection.contentLengthLong)
                } else connection.contentLengthLong
                var downloaded = existing
                connection.inputStream.use { input ->
                    FileOutputStream(partial, existing > 0).use { output ->
                        val buffer = ByteArray(1024 * 1024)
                        while (true) {
                            if (cancel.get() || Thread.currentThread().isInterrupted) throw InterruptedException("Model download cancelled.")
                            val count = input.read(buffer)
                            if (count < 0) break
                            output.write(buffer, 0, count)
                            downloaded += count
                            val percent = if (total > 0) ((downloaded * 100L) / total).toInt().coerceIn(0, 100) else 0
                            notifyListeners("modelDownloadProgress", JSObject()
                                .put("id", id).put("downloadedBytes", downloaded).put("totalBytes", total)
                                .put("percent", percent).put("status", "Downloading"))
                        }
                        output.fd.sync()
                    }
                }
                connection.disconnect()
                if (expectedSize > 0 && partial.length() != expectedSize) throw IllegalStateException("Downloaded size does not match Hugging Face file metadata.")
                val digest = sha256(partial)
                if (expectedSha.isNotEmpty() && !digest.equals(expectedSha, true)) throw IllegalStateException("SHA-256 verification failed. The partial file was not installed.")
                android.system.Os.rename(partial.absolutePath, target.absolutePath)
                File(modelRoot, id + ".json").writeText(org.json.JSONObject().put("repo", repo).put("sourceFile", remotePath).put("sha256", digest).put("sha256Verified", expectedSha.isNotEmpty()).put("sizeBytes", target.length()).toString())
                notifyListeners("modelDownloadProgress", JSObject()
                    .put("id", id).put("downloadedBytes", target.length()).put("totalBytes", target.length())
                    .put("percent", 100).put("status", "Installed").put("sha256", digest))
                activity.runOnUiThread {
                    call.resolve(JSObject().put("id", id).put("sizeBytes", target.length()).put("sha256", digest))
                }
            } catch (error: Exception) {
                activity.runOnUiThread { call.reject(error.message ?: "Model download failed.") }
            } finally {
                activeDownloads.remove(id, cancel)
            }
        }, "axiom-model-download").apply { isDaemon = true }.start()
    }

    @PluginMethod
    fun cancelModelDownload(call: PluginCall) {
        val id = call.getString("id").orEmpty()
        activeDownloads[id]?.set(true)
        call.resolve(JSObject().put("cancelling", activeDownloads.containsKey(id)))
    }

    @PluginMethod
    fun deleteLocalModel(call: PluginCall) {
        val id = call.getString("id").orEmpty()
        if (id.isBlank() || id.contains("/") || id.contains("..")) return call.reject("Invalid model ID.")
        val file = File(modelRoot, id).canonicalFile
        if (file.parentFile != modelRoot || !file.isFile || !file.name.endsWith(".gguf", true)) return call.reject("Model not found.")
        if (llamaLoadedModel() == file.absolutePath) return call.reject("Unload this model before deleting it.")
        val bytes = file.length()
        if (!file.delete()) return call.reject("Could not delete model file.")
        File(modelRoot, id + ".json").delete()
        call.resolve(JSObject().put("deleted", true).put("freedBytes", bytes))
    }

    @PluginMethod
    fun loadLocalModel(call: PluginCall) {
        val id = call.getString("id").orEmpty()
        if (id.isBlank() || id.contains("/") || id.contains("..")) return call.reject("Invalid model ID.")
        val file = File(modelRoot, id).canonicalFile
        if (file.parentFile != modelRoot || !file.isFile || !file.name.endsWith(".gguf", true)) return call.reject("Model not found in Axiom private storage.")
        val contextSize = (call.getInt("contextSize") ?: 2048).coerceIn(512, 8192)
        val threads = (call.getInt("threads") ?: Runtime.getRuntime().availableProcessors().coerceAtMost(6)).coerceIn(1, 16)
        val gpuLayers = (call.getInt("gpuLayers") ?: 0).coerceIn(-1, 999)
        Thread({
            try {
                if (!llamaLoadModel(file.absolutePath, contextSize, threads, gpuLayers)) {
                    throw IllegalStateException("llama.cpp could not load this GGUF. Check model compatibility and available RAM.")
                }
                activity.runOnUiThread { call.resolve(JSObject().put("loaded", true).put("id", id).put("contextSize", contextSize).put("threads", threads).put("requestedGpuLayers", gpuLayers).put("gpuOffloadSupported", gpuOffloadSupported())) }
            } catch (error: Exception) {
                activity.runOnUiThread { call.reject(error.message ?: "Model loading failed.") }
            }
        }, "axiom-model-load").apply { isDaemon = true }.start()
    }

    @PluginMethod
    fun unloadLocalModel(call: PluginCall) {
        Thread({
            llamaUnloadModel()
            activity.runOnUiThread { call.resolve(JSObject().put("loaded", false)) }
        }, "axiom-model-unload").apply { isDaemon = true }.start()
    }

    @PluginMethod
    fun cancelLocalGeneration(call: PluginCall) {
        val active = generationActive.get()
        if (active) generationCancelled.set(true)
        call.resolve(JSObject().put("cancelling", active))
    }

    @PluginMethod
    fun generateLocal(call: PluginCall) {
        val messages = call.getArray("messages") ?: return call.reject("Conversation messages are required.")
        if (messages.length() == 0 || messages.length() > 64) return call.reject("Conversation must contain 1-64 messages.")
        val roles = ArrayList<String>(messages.length())
        val contents = ArrayList<String>(messages.length())
        try {
            for (index in 0 until messages.length()) {
                val message = messages.getJSONObject(index)
                val role = message.optString("role", "user")
                if (role !in setOf("system", "user", "assistant", "tool")) return call.reject("Unsupported conversation role.")
                roles.add(role)
                contents.add(message.optString("content", ""))
            }
        } catch (_: Exception) {
            return call.reject("Conversation message format is invalid.")
        }
        val maxTokens = (call.getInt("maxTokens") ?: 512).coerceIn(1, 4096)
        if (!generationActive.compareAndSet(false, true)) {
            return call.reject("A native generation is already running. Cancel it or wait for it to finish.")
        }
        generationCancelled.set(false)
        Thread({
            try {
                val callback = object {
                    @Suppress("unused")
                    fun onToken(token: String) {
                        notifyListeners("nativeModelToken", JSObject().put("token", token))
                    }
                    @Suppress("unused")
                    fun isCancelled(): Boolean = generationCancelled.get()
                }
                val output = llamaGenerate(roles.toTypedArray(), contents.toTypedArray(), maxTokens, callback)
                val wasCancelled = generationCancelled.get()
                activity.runOnUiThread { call.resolve(JSObject().put("text", output).put("cancelled", wasCancelled)) }
            } catch (error: Exception) {
                activity.runOnUiThread { call.reject(error.message ?: "Native inference failed.") }
            } finally {
                generationCancelled.set(false)
                generationActive.set(false)
            }
        }, "axiom-native-inference").apply { isDaemon = true }.start()
    }

    private fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        FileInputStream(file).use { input ->
            val buffer = ByteArray(1024 * 1024)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                digest.update(buffer, 0, count)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }
}
