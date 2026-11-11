# Android local AI setup (Termux bridge)

This is the compatibility path for Android devices until Axiom ships its own native inference runtime. It installs a community-built ARM64 Ollama distribution inside Termux and runs Axiom's Node gateway beside it. It does **not** install Ollama into the Axiom APK.

## 1. Install Termux

Install Termux from one of its official distribution channels:

- [F-Droid package page](https://f-droid.org/packages/com.termux/)
- [Official Termux GitHub releases](https://github.com/termux/termux-app/releases)

Install and open Termux once before continuing. Do not mix Termux add-ons from different distribution sources because their APK signing keys differ.

## 2. Run the Axiom bootstrap

Open Termux, paste this command, and let it finish:

```bash
curl -fsSL https://raw.githubusercontent.com/michaelkage/Axiom/main/pwa/scripts/setup-termux-ollama.sh -o axiom-termux-setup.sh && bash axiom-termux-setup.sh
```

The script:

1. Updates Termux packages and installs Node.js LTS, Git, and curl.
2. Installs the pinned ARM64 Termux Ollama distribution and runs its installer. The package installer verifies the downloaded release archive against its SHA-256 file.
3. Starts Ollama on `127.0.0.1:11434` if it is not already running.
4. Clones or fast-forward updates Axiom's gateway source in `~/.local/share/axiom-gateway-runtime`.
5. Starts the Axiom gateway on `127.0.0.1:8787`.

The gateway remains in the foreground in that Termux session. Keep the session open while using the Termux-backed runtime. Press Ctrl+C to stop the gateway. Ollama is started separately in the background.

## 3. Pair Axiom

On the gateway's first startup, it generates a random 256-bit pairing token, stores it in `~/.config/axiom/gateway-token`, and prints it once.

In Axiom:

1. Open **Settings → Secure gateway pairing**.
2. Set the gateway URL to `http://127.0.0.1:8787`.
3. Paste the one-time pairing token and save.
4. Open **Models**, refresh the library, and install a small model such as `qwen2.5:1.5b`.

Do not paste the pairing token into chat, screenshots, source code, or public issue reports. Axiom stores its copy encrypted with Android Keystore. The gateway token is not a GitHub or Supabase credential.

If the gateway has already generated a token and you need to retrieve it, run this locally in Termux:

```bash
cat ~/.config/axiom/gateway-token
```

That file is private to the Termux app's Linux home directory. Do not send its contents to anyone.

## 4. Start it again later

Open Termux and start the gateway:

```bash
cd ~/.local/share/axiom-gateway-runtime/pwa
OLLAMA_BASE_URL=http://127.0.0.1:11434 node gateway/server.mjs
```

If Ollama is not running, start it in another Termux session:

```bash
ollama serve
```

Check Ollama directly:

```bash
curl http://127.0.0.1:11434/api/tags
```

If Android kills Termux in the background, reopen Termux and restart the processes. Android battery management and vendor task killers can interrupt background work. Axiom's foreground notification does not control Termux's process lifecycle.

## Compatibility and trust notes

- This bridge currently targets **64-bit ARM Android** (`aarch64`). It deliberately stops on other architectures.
- The installer pins `@mmmbuto/ollama-termux@0.33.1-termux`, a third-party Termux adaptation, not an official Ollama Android release. Its GitHub repository was archived on 29 August 2026. Treat it as a temporary compatibility option, not a supported long-term dependency. Review the package and release before installing if your threat model requires independent code review.
- The standard Ollama Linux installer is not an Android/Termux installer. Do not run `curl https://ollama.com/install.sh | sh` inside Termux and assume it creates a supported Android runtime.
- Model downloads use phone storage and mobile data. Check available storage and the model's license/quantization before installing. A 1.5B model is a more sensible first test than downloading a multi-gigabyte model and hoping the phone cooperates.
- This setup does not grant Axiom arbitrary Termux filesystem access. The Axiom native shell workspace remains app-private.
- The Termux gateway is bound to loopback. Do not change it to `0.0.0.0` or expose port 8787 publicly.

## Native Axiom runtime roadmap

The long-term implementation is independent of Termux and Ollama:

- Android NDK inference engine using llama.cpp, compiled for supported ARM ABIs.
- App-private model library under Axiom's internal files directory.
- Hugging Face GGUF search, resumable downloads, SHA-256 verification, and atomic installation.
- Model metadata, license/source attribution, quantization and storage estimates.
- Model activation, unload, delete, and storage reclamation.
- Streaming token generation bridged to the React chat layer, with cancellation, context limits, and runtime diagnostics.
- Thermal, RAM, and battery-aware inference settings. Vulkan acceleration only when the device driver passes runtime checks, with CPU fallback.

The native engine must not shell out to Termux or depend on an Ollama daemon. Model files remain in Axiom's private app storage and are removed when the app's data is cleared or the app is uninstalled.
