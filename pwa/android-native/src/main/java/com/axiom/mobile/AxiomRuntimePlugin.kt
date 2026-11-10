package com.axiom.mobile

import android.content.Intent
import android.os.Build
import android.os.Environment
import android.util.Base64
import com.getcapacitor.*
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.File
import java.io.FileInputStream
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ConcurrentHashMap

@CapacitorPlugin(name = "AxiomRuntime")
class AxiomRuntimePlugin : Plugin() {
    private data class Terminal(val handle: Long, val reader: Thread)
    private val terminals = ConcurrentHashMap<String, Terminal>()
    private val random = SecureRandom()
    @Volatile private var sessionToken: String? = null
    private val prefs by lazy { context.getSharedPreferences("axiom_runtime", 0) }
    private val workspaceRoot: File by lazy {
        File(context.filesDir, "workspaces").apply { mkdirs() }.canonicalFile
    }

    private external fun nativeStart(cwd: String, rows: Int, cols: Int): Long
    private external fun nativeRead(handle: Long, buffer: ByteArray, offset: Int, length: Int): Int
    private external fun nativeWrite(handle: Long, data: ByteArray): Int
    private external fun nativeResize(handle: Long, rows: Int, cols: Int): Boolean
    private external fun nativeClose(handle: Long, signal: Int): Boolean

    override fun load() {
        super.load()
        System.loadLibrary("axiompty")
    }

    @PluginMethod
    fun getRuntimeInfo(call: PluginCall) {
        val active = prefs.getString("active_workspace", "default") ?: "default"
        val workspace = safeWorkspace(active)
        val result = JSObject()
        result.put("platform", "android")
        result.put("native", true)
        result.put("pty", true)
        result.put("workspaceRoot", workspaceRoot.absolutePath)
        result.put("activeWorkspace", active)
        result.put("activeWorkspacePath", workspace.absolutePath)
        result.put("terminalCount", terminals.size)
        result.put("serviceRequested", prefs.getBoolean("service_requested", false))
        result.put("keepAwake", prefs.getBoolean("keep_awake", false))
        call.resolve(result)
    }

    @PluginMethod
    fun listWorkspaces(call: PluginCall) {
        val result = JSArray()
        workspaceRoot.listFiles()?.filter { it.isDirectory }?.sortedBy { it.name }?.forEach {
            val item = JSObject()
            item.put("name", it.name)
            item.put("path", it.canonicalPath)
            result.put(item)
        }
        call.resolve(JSObject().put("workspaces", result))
    }

    @PluginMethod
    fun createWorkspace(call: PluginCall) {
        val name = call.getString("name")?.trim().orEmpty()
        if (!name.matches(Regex("[A-Za-z0-9][A-Za-z0-9._ -]{0,47}"))) {
            call.reject("Workspace name must be 1-48 safe characters.")
            return
        }
        try {
            val directory = safeWorkspace(name)
            if (!directory.exists() && !directory.mkdirs()) throw IllegalStateException("Could not create workspace.")
            prefs.edit().putString("active_workspace", name).apply()
            call.resolve(JSObject().put("name", name).put("path", directory.absolutePath))
        } catch (error: Exception) {
            call.reject(error.message ?: "Workspace creation failed.")
        }
    }

    @PluginMethod
    fun selectWorkspace(call: PluginCall) {
        val name = call.getString("name")?.trim().orEmpty()
        try {
            val directory = safeWorkspace(name)
            if (!directory.isDirectory) throw IllegalArgumentException("Workspace does not exist.")
            prefs.edit().putString("active_workspace", name).apply()
            call.resolve(JSObject().put("name", name).put("path", directory.absolutePath))
        } catch (error: Exception) {
            call.reject(error.message ?: "Workspace selection failed.")
        }
    }

    @PluginMethod
    fun startTerminal(call: PluginCall) {
        val id = call.getString("sessionId")?.takeIf { it.matches(Regex("[A-Za-z0-9_-]{1,64}")) }
            ?: java.util.UUID.randomUUID().toString()
        if (terminals.containsKey(id)) {
            call.reject("Terminal session already exists.")
            return
        }
        try {
            val workspace = prefs.getString("active_workspace", "default") ?: "default"
            val cwd = safeWorkspace(workspace)
            if (!cwd.exists() && !cwd.mkdirs()) throw IllegalStateException("Workspace is unavailable.")
            val rows = (call.getInt("rows") ?: 24).coerceIn(2, 200)
            val cols = (call.getInt("cols") ?: 80).coerceIn(2, 400)
            val handle = nativeStart(cwd.absolutePath, rows, cols)
            if (handle == 0L) throw IllegalStateException("Could not create Android PTY.")
            val reader = Thread({
                val buffer = ByteArray(8192)
                try {
                    while (!Thread.currentThread().isInterrupted) {
                        val count = nativeRead(handle, buffer, 0, buffer.size)
                        if (count <= 0) break
                        val chunk = String(buffer, 0, count, Charsets.UTF_8)
                        val event = JSObject().put("sessionId", id).put("data", chunk)
                        notifyListeners("ptyData", event)
                    }
                } catch (_: Exception) {
                } finally {
                    nativeClose(handle, 15)
                    terminals.remove(id)
                    notifyListeners("ptyExit", JSObject().put("sessionId", id))
                }
            }, "axiom-pty-$id").apply { isDaemon = true }
            terminals[id] = Terminal(handle, reader)
            reader.start()
            call.resolve(JSObject().put("sessionId", id).put("cwd", cwd.absolutePath).put("rows", rows).put("cols", cols))
        } catch (error: Exception) {
            call.reject(error.message ?: "Terminal start failed.")
        }
    }

    @PluginMethod
    fun writeTerminal(call: PluginCall) {
        val id = call.getString("sessionId").orEmpty()
        val terminal = terminals[id] ?: return call.reject("Terminal session not found.")
        val data = call.getString("data") ?: return call.reject("Terminal data is required.")
        val written = nativeWrite(terminal.handle, data.toByteArray(Charsets.UTF_8))
        if (written < 0) call.reject("Terminal write failed.") else call.resolve(JSObject().put("written", written))
    }

    @PluginMethod
    fun resizeTerminal(call: PluginCall) {
        val terminal = terminals[call.getString("sessionId").orEmpty()] ?: return call.reject("Terminal session not found.")
        val rows = (call.getInt("rows") ?: 24).coerceIn(2, 200)
        val cols = (call.getInt("cols") ?: 80).coerceIn(2, 400)
        if (!nativeResize(terminal.handle, rows, cols)) call.reject("Terminal resize failed.")
        else call.resolve()
    }

    @PluginMethod
    fun stopTerminal(call: PluginCall) {
        val id = call.getString("sessionId").orEmpty()
        val terminal = terminals.remove(id) ?: return call.resolve()
        nativeClose(terminal.handle, if (call.getBoolean("interrupt") == true) 2 else 15)
        terminal.reader.interrupt()
        call.resolve()
    }

    @PluginMethod
    fun setGatewayBootstrapToken(call: PluginCall) {
        val token = call.getString("token").orEmpty()
        if (token.length < 32 || token.length > 4096) return call.reject("Gateway pairing token must contain at least 32 characters.")
        try {
            val encrypted = encrypt(token)
            prefs.edit().putString("gateway_bootstrap", Base64.encodeToString(encrypted, Base64.NO_WRAP)).apply()
            call.resolve(JSObject().put("stored", true))
        } catch (error: Exception) {
            call.reject(error.message ?: "Could not securely store gateway token.")
        }
    }

    @PluginMethod
    fun registerGatewaySession(call: PluginCall) {
        val gatewayUrl = call.getString("gatewayUrl").orEmpty().trimEnd('/')
        val parsedGateway = try { java.net.URL(gatewayUrl) } catch (_: Exception) { return call.reject("Gateway URL must be a valid HTTP(S) URL.") }
        if ((parsedGateway.protocol != "http" && parsedGateway.protocol != "https") || parsedGateway.userInfo != null || parsedGateway.host.isBlank()) return call.reject("Gateway URL must be a valid HTTP(S) URL without embedded credentials.")
        Thread({
            try {
                val bootstrap = prefs.getString("gateway_bootstrap", null)
                    ?: throw IllegalStateException("Pair the gateway in Settings first.")
                val secret = decrypt(Base64.decode(bootstrap, Base64.NO_WRAP))
                val token = sessionToken ?: ByteArray(32).also(random::nextBytes).let { Base64.encodeToString(it, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING) }.also { sessionToken = it }
                val connection = URL("$gatewayUrl/session/register").openConnection() as HttpURLConnection
                connection.requestMethod = "POST"
                connection.connectTimeout = 8000
                connection.readTimeout = 8000
                connection.doOutput = true
                connection.setRequestProperty("Authorization", "Bearer $secret")
                connection.setRequestProperty("Content-Type", "application/json")
                connection.outputStream.use { it.write(JSONObject().put("token", token).put("ttlSeconds", 43200).toString().toByteArray()) }
                val status = connection.responseCode
                if (status !in 200..299) throw IllegalStateException("Gateway session registration failed (HTTP $status).")
                connection.disconnect()
                val result = JSObject().put("token", token).put("expiresIn", 43200)
                activity.runOnUiThread { call.resolve(result) }
            } catch (error: Exception) {
                activity.runOnUiThread { call.reject(error.message ?: "Gateway registration failed.") }
            }
        }, "axiom-gateway-register").apply { isDaemon = true }.start()
    }

    @PluginMethod
    fun startBackgroundService(call: PluginCall) {
        if (Build.VERSION.SDK_INT >= 33 && context.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            activity.requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 8787)
        }
        val intent = Intent(context, AxiomRuntimeService::class.java).setAction(AxiomRuntimeService.ACTION_START)
        if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent) else context.startService(intent)
        prefs.edit().putBoolean("service_requested", true).apply()
        call.resolve(JSObject().put("running", true))
    }

    @PluginMethod
    fun stopBackgroundService(call: PluginCall) {
        context.stopService(Intent(context, AxiomRuntimeService::class.java))
        prefs.edit().putBoolean("service_requested", false).putBoolean("keep_awake", false).apply()
        call.resolve(JSObject().put("running", false))
    }

    @PluginMethod
    fun setKeepAwake(call: PluginCall) {
        val enabled = call.getBoolean("enabled") ?: false
        prefs.edit().putBoolean("keep_awake", enabled).putBoolean("service_requested", if (enabled) true else prefs.getBoolean("service_requested", false)).apply()
        if (enabled || prefs.getBoolean("service_requested", false)) {
            val intent = Intent(context, AxiomRuntimeService::class.java).setAction(AxiomRuntimeService.ACTION_WAKE_LOCK)
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent) else context.startService(intent)
        }
        call.resolve(JSObject().put("enabled", enabled))
    }

    private fun safeWorkspace(name: String): File {
        require(name.matches(Regex("[A-Za-z0-9][A-Za-z0-9._ -]{0,47}"))) { "Invalid workspace name." }
        val candidate = File(workspaceRoot, name).canonicalFile
        require(candidate.parentFile == workspaceRoot) { "Workspace path escapes the private workspace root." }
        return candidate
    }

    private fun encrypt(value: String): ByteArray {
        val key = getOrCreateKey()
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key)
        return cipher.iv + cipher.doFinal(value.toByteArray(Charsets.UTF_8))
    }

    private fun decrypt(value: ByteArray): String {
        val key = getOrCreateKey()
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, value.copyOfRange(0, 12)))
        return String(cipher.doFinal(value.copyOfRange(12, value.size)), Charsets.UTF_8)
    }

    private fun getOrCreateKey(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey("axiom.gateway.bootstrap", null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance("AES", "AndroidKeyStore")
        generator.init(android.security.keystore.KeyGenParameterSpec.Builder(
            "axiom.gateway.bootstrap",
            android.security.keystore.KeyProperties.PURPOSE_ENCRYPT or android.security.keystore.KeyProperties.PURPOSE_DECRYPT
        ).setBlockModes(android.security.keystore.KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(android.security.keystore.KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true).build())
        return generator.generateKey()
    }
}
