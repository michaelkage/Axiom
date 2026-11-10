# Axiom Mobile Android validation

This checklist is required before calling the PWA Android-ready. Chromium emulation is useful, but it is not a substitute for a real device.

## 1. Prepare the host

1. Install Node.js 20 or newer on the machine running Ollama and the Axiom gateway.
2. Start Ollama and confirm it is reachable from the host.
3. Start the gateway using the instructions in [gateway/README.md](./gateway/README.md).
4. For a phone connecting over Wi-Fi, bind the gateway to the host LAN interface only when needed, firewall the port, and put a trusted HTTPS reverse proxy in front of it. Do not expose the raw gateway port to the public internet.
5. Set `AXIOM_ALLOWED_ORIGINS` to the exact HTTPS origin serving the PWA. Configure `GITHUB_TOKEN`, `GITHUB_REPOSITORY`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, and `MCP_SERVERS_JSON` only when those integrations are required.

## 2. Install on Android Chrome

1. Open the HTTPS PWA URL in current Chrome on Android.
2. Open the browser menu and choose **Install app** or **Add to Home screen**.
3. Launch Axiom from the Android launcher, not from the browser tab.
4. Confirm it opens in standalone display mode with the Axiom icon and no browser address bar.
5. Confirm the bottom navigation, header, composer, and settings dialog respect the display cutout and gesture-navigation safe areas.

## 3. Functional checks

- Send at least three sequential prompts and verify each receives a response.
- Stop a streaming response and verify partial output remains visible.
- Switch between Chat, Tools, MCP, and Logs while preserving conversation state.
- Approve and decline a tool call. Confirm a declined action never reaches the upstream tool.
- Connect an allowlisted MCP server by gateway ID and verify tool discovery and invocation.
- Verify GitHub reads/writes are limited to the configured repository.
- Verify Supabase operations use the publishable key and database RLS, never a service-role key.
- Open settings, enter the gateway token, reload the app, and confirm the token is not restored from browser storage.

## 4. Android-specific checks

- Test portrait at 360–430 CSS pixels and landscape.
- Open the keyboard, type a multiline prompt, send with the keyboard action, and confirm the composer and navigation remain usable.
- Background and foreground the app during a stream; verify cancellation or reconnection is explicit and no duplicate tool call occurs.
- Disable Wi-Fi, reload the app, and confirm the cached shell loads while API-dependent features show a clear offline state.
- Re-enable Wi-Fi and verify Ollama and MCP can reconnect.
- Test on both Wi-Fi and mobile data if the gateway is intended to be reachable on both networks.
- Verify the Android device can resolve and reach the gateway host. Never assume `localhost` on the phone refers to the desktop running Ollama.

## 5. Sign-off record

Record device model, Android version, Chrome version, PWA build SHA, gateway host topology, and pass/fail for each check. Do not mark physical-device validation complete until this record exists.
