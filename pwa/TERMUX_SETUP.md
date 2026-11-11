# Optional Android Termux bridge

Axiom's installed Android app already includes a native llama.cpp inference engine for on-device GGUF models. **You do not need Termux, Ollama, or the gateway to use native local models.**

This guide configures an optional compatibility bridge for Ollama-hosted models and gateway-managed integrations such as GitHub, Supabase, and MCP. It installs a community-built ARM64 Ollama distribution inside the separate Termux app and runs Axiom's Node gateway beside it. It does not install Ollama into the Axiom APK.

> **Two separate shells:** Axiom's built-in Terminal runs Android `/system/bin/sh` inside Axiom's private app storage. It is a developer shell for Android diagnostics and Axiom workspace files, not a Linux distribution. It does not include Node.js, npm, pip, apt, or access to Termux files. Run every command in this guide in the separate **Termux app**, not Axiom → Terminal.

## 1. Install Termux

Install Termux from one of its official distribution channels:

- [F-Droid package page](https://f-droid.org/packages/com.termux/)
- [Official Termux GitHub releases](https://github.com/termux/termux-app/releases)

Install and open Termux once before continuing. Do not mix Termux add-ons from different distribution sources because their APK signing keys differ.

## 2. Run the one-command bootstrap

Open Termux and run:

```bash
pkg install -y curl && curl -fsSL https://raw.githubusercontent.com/michaelkage/Axiom/main/pwa/scripts/setup-termux-ollama.sh -o axiom-termux-setup.sh && bash axiom-termux-setup.sh
```

The bootstrap:

1. Updates Termux packages and installs Node.js LTS, Git, and curl.
2. Installs the pinned ARM64 Termux Ollama distribution and verifies its downloaded release archive.
3. Starts Ollama on `127.0.0.1:11434` if it is not already running.
4. Clones or fast-forward updates Axiom's gateway source in `~/.local/share/axiom-gateway-runtime`.
5. Starts the gateway on `127.0.0.1:8787`.
6. Hands the gateway credential directly to the installed Axiom Android app.

Keep the Termux session open while using the Termux-backed runtime. Press Ctrl+C to stop the gateway. Ollama runs separately in the background.

## 3. Automatic Android pairing

The bootstrap sets `AXIOM_GATEWAY_SILENT_TOKEN=1`, so the gateway does not print its pairing secret into `~/.axiom-gateway.log`. The credential is generated and stored in Termux's private app directory, then passed to Axiom through an explicit, package-scoped Android intent extra.

Axiom validates the credential with the gateway, immediately replaces the Activity launch intent to clear the secret, encrypts the bootstrap credential with Android Keystore, and registers renewable short-lived sessions.

**No token is displayed, copied, pasted, or stored in shell history.** Keep Axiom installed before running the bootstrap. The gateway credential remains private to Termux and Axiom; it is not a GitHub or Supabase credential.

If automatic pairing fails:

- Check gateway startup errors in `~/.axiom-gateway.log`. The pairing token is intentionally suppressed from this log.
- Confirm Axiom is installed and has been opened at least once.
- Reopen Axiom and rerun the bootstrap from Termux.

## 4. Start the bridge again later

Open Termux and run:

```bash
cd ~/.local/share/axiom-gateway-runtime/pwa
OLLAMA_BASE_URL=http://127.0.0.1:11434 AXIOM_GATEWAY_SILENT_TOKEN=1 node gateway/server.mjs
```

If Ollama is not running, start it in another Termux session:

```bash
ollama serve
```

Check Ollama directly:

```bash
curl http://127.0.0.1:11434/api/tags
```

The gateway reuses its existing pairing credential. The silent-token setting prevents first-run output if the credential file is ever regenerated.

If Android kills Termux in the background, reopen Termux and restart the processes. Android battery management and vendor task killers can interrupt background work. Axiom's foreground notification does not control Termux's process lifecycle.

## Compatibility and trust notes

- This bridge currently targets **64-bit ARM Android** (`aarch64`). It deliberately stops on other architectures.
- The installer pins `@mmmbuto/ollama-termux@0.33.1-termux`, a third-party Termux adaptation, not an official Ollama Android release. Its GitHub repository was archived on 29 August 2026. Treat it as a temporary compatibility option, not a supported long-term dependency. Review the package and release before installing if your threat model requires independent code review.
- The standard Ollama Linux installer is not an Android/Termux installer. Do not run `curl https://ollama.com/install.sh | sh` inside Termux and assume it creates a supported Android runtime.
- Model downloads use phone storage and mobile data. Check available storage and the model's license and quantization before installing.
- This setup does not grant Axiom arbitrary Termux filesystem access. The Axiom native shell workspace remains app-private.
- The Termux gateway is bound to loopback. Do not change it to `0.0.0.0` or expose port 8787 publicly.
- Native GGUF models downloaded through Axiom's Models tab are stored in Axiom's private app storage and do not depend on the Termux filesystem.

## Native Axiom runtime

The installed Android app includes a native inference engine built on llama.cpp:

- ARM64 Android NDK runtime with Vulkan backend and CPU fallback.
- App-private GGUF model library.
- Hugging Face GGUF search, resumable downloads, SHA-256 verification, and atomic installation.
- Model activation, unload, delete, storage accounting, and context configuration.
- Streaming generation, cancellation, and chat tool-approval integration.
- Runtime diagnostics for load time, first-token latency, throughput, memory, battery temperature, thermal state, and GPU capability.

The native engine does not shell out to Termux or depend on an Ollama daemon. Model files remain in Axiom's private app storage and are removed when app data is cleared or the app is uninstalled.
