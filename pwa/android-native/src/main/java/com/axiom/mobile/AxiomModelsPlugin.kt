package com.axiom.mobile

import android.app.ActivityManager
import android.os.StatFs
import com.getcapacitor.*
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.security.MessageDigest
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean

@CapacitorPlugin(name = "AxiomModels")
class AxiomModelsPlugin : Plugin() {
    private val modelRoot: File by lazy { File(context.filesDir, "models").apply { mkdirs() }.canonicalFile }
    private val activeDownloads = ConcurrentHashMap<String, AtomicBoolean>()
    @Volatile private var generationCancelled = false

    private external fun llamaLoadModel(path: String, contextSize: Int, threads: Int): Boolean
    private external fun llamaUnloadModel()
    private external fun llamaLoadedModel(): String
    private external fun llamaGenerate(prompt: String, maxTokens: Int, callback: Any): String
    private external fun isVulkanAvailable(): Boolean

    override fun load() {
        super.load()
        System.loadLibrary("axiompty")
    }

    @PluginMethod
    fun getDeviceCapabilities(call: PluginCall) {
        val memory = ActivityManager.MemoryInfo()
        (context.getSystemService(android.content.Context.ACTIVITY_SERVICE) as ActivityManager).getMemoryInfo(memory)
        val stat = StatFs(modelRoot.absolutePath)
        call.resolve(JSObject()
            .put("platform", "android")
            .put("abis", JSArray().apply { android.os.Build.SUPPORTED_ABIS.forEach { put(it) } })
            .put("primaryAbi", android.os.Build.SUPPORTED_ABIS.firstOrNull() ?: "unknown")
            .put("cpuCores", Runtime.getRuntime().availableProcessors())
            .put("totalRamBytes", memory.totalMem)
            .put("availableRamBytes", memory.availMem)
            .put("lowMemory", memory.lowMemory)
            .put("storageAvailableBytes", stat.availableBytes)
            .put("storageTotalBytes", stat.totalBytes)
            .put("vulkanLoaderAvailable", isVulkanAvailable())
            .put("inferenceBackend", "llama.cpp CPU")
            .put("loadedModel", llamaLoadedModel()))
    }

    @PluginMethod
    fun listLocalModels(call: PluginCall) {
        val result = JSArray()
        modelRoot.listFiles()?.filter { it.isFile && it.name.endsWith(".gguf", true) }?.sortedBy { it.name }?.forEach { file ->
            result.put(JSObject()
                .put("id", file.name)
                .put("name", file.name)
                .put("sizeBytes", file.length())
                .put("sha256", sha256(file))
                .put("loaded", llamaLoadedModel() == file.absolutePath))
        }
        call.resolve(JSObject().put("models", result))
    }

    @PluginMethod
    fun getHuggingFaceModelFiles(call: PluginCall) {
        val repo = call.getString("repo").orEmpty()
        if (!repo.matches(Regex("[A-Za-z0-9_.-]{1,96}/[A-Za-z0-9_.-]{1,96}"))) return call.reject("Invalid Hugging Face repository ID.")
        Thread({
            try {
                val connection = URL("https://huggingface.co/api/models/$repo/tree/main?recursive=true&expand=true").openConnection() as HttpURLConnection
                connection.connectTimeout = 12000
                connection.readTimeout = 20000
                connection.setRequestProperty("Accept", "application/json")
                val status = connection.responseCode
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

        val id = (repo.replace("/", "--") + "--" + remotePath.substringAfterLast("/")).replace(Regex("[^A-Za-z0-9._-]"), "_")
        val target = File(modelRoot, id).canonicalFile
        if (target.parentFile != modelRoot) return call.reject("Model path escaped private storage.")
        val partial = File(modelRoot, "$id.part")
        val cancel = AtomicBoolean(false)
        activeDownloads.put(id, cancel)?.set(true)

        Thread({
            try {
                val stat = StatFs(modelRoot.absolutePath)
                if (expectedSize > 0 && stat.availableBytes < expectedSize + 128L * 1024L * 1024L) {
                    throw IllegalStateException("Not enough free storage. Free at least \${expectedSize + 128L * 1024L * 1024L} bytes before downloading.")
                }
                var existing = if (partial.exists()) partial.length() else 0L
                val encodedPath = remotePath.split("/").joinToString("/") { URLEncoder.encode(it, "UTF-8").replace("+", "%20") }
                val connection = URL("https://huggingface.co/$repo/resolve/main/$encodedPath?download=true").openConnection() as HttpURLConnection
                connection.instanceFollowRedirects = true
                connection.connectTimeout = 15000
                connection.readTimeout = 30000
                if (existing > 0) connection.setRequestProperty("Range", "bytes=$existing-")
                val status = connection.responseCode
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
                if (target.exists() && !target.delete()) throw IllegalStateException("Could not replace existing model.")
                if (!partial.renameTo(target)) throw IllegalStateException("Could not atomically install downloaded model.")
                notifyListeners("modelDownloadProgress", JSObject()
                    .put("id", id).put("downloadedBytes", target.length()).put("totalBytes", target.length())
                    .put("percent", 100).put("status", "Installed").put("sha256", digest))
                activity.runOnUiThread {
                    call.resolve(JSObject().put("id", id).put("sizeBytes", target.length()).put("sha256", digest))
                }
            } catch (error: Exception) {
                activity.runOnUiThread { call.reject(error.message ?: "Model download failed.") }
            } finally {
                activeDownloads.remove(id)
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
        Thread({
            try {
                if (!llamaLoadModel(file.absolutePath, contextSize, threads)) {
                    throw IllegalStateException("llama.cpp could not load this GGUF. Check model compatibility and available RAM.")
                }
                activity.runOnUiThread { call.resolve(JSObject().put("loaded", true).put("id", id).put("contextSize", contextSize).put("threads", threads)) }
            } catch (error: Exception) {
                activity.runOnUiThread { call.reject(error.message ?: "Model loading failed.") }
            }
        }, "axiom-model-load").apply { isDaemon = true }.start()
    }

    @PluginMethod
    fun unloadLocalModel(call: PluginCall) {
        llamaUnloadModel()
        call.resolve(JSObject().put("loaded", false))
    }

    @PluginMethod
    fun cancelLocalGeneration(call: PluginCall) {
        generationCancelled = true
        call.resolve(JSObject().put("cancelling", true))
    }

    @PluginMethod
    fun generateLocal(call: PluginCall) {
        val prompt = call.getString("prompt")?.takeIf { it.isNotBlank() } ?: return call.reject("Prompt is required.")
        val maxTokens = (call.getInt("maxTokens") ?: 512).coerceIn(1, 4096)
        generationCancelled = false
        Thread({
            try {
                val callback = object {
                    @Suppress("unused")
                    fun onToken(token: String) {
                        notifyListeners("nativeModelToken", JSObject().put("token", token))
                    }
                    @Suppress("unused")
                    fun isCancelled(): Boolean = generationCancelled
                }
                val output = llamaGenerate(prompt, maxTokens, callback)
                activity.runOnUiThread { call.resolve(JSObject().put("text", output).put("cancelled", generationCancelled)) }
            } catch (error: Exception) {
                activity.runOnUiThread { call.reject(error.message ?: "Native inference failed.") }
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
