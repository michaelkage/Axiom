"use strict";

const PROVIDERS = Object.freeze({
  github: { namespace: "provider-github", key: "pat", prefixes: ["ghp_", "github_pat_"] },
  supabase: { namespace: "provider-supabase", key: "pat", prefixes: ["sbp_"] },
});
const MAX_SECRET_LENGTH = 8192;

function validateProviderSecret(providerId, secret) {
  const provider = PROVIDERS[providerId];
  if (!provider) throw new TypeError("Unsupported credential provider.");
  if (typeof secret !== "string" || secret.length < 20 || secret.length > MAX_SECRET_LENGTH || secret.trim() !== secret || /[\r\n\0]/.test(secret)) {
    throw new TypeError("Credential must be a bounded, single-line secret.");
  }
  if (!provider.prefixes.some(prefix => secret.startsWith(prefix))) {
    throw new TypeError("Credential format does not match the selected provider.");
  }
  return provider;
}

function createProviderCredentialManager(secureStore) {
  if (!secureStore || typeof secureStore.get !== "function" || typeof secureStore.set !== "function" || typeof secureStore.remove !== "function") {
    throw new TypeError("A secure credential store is required.");
  }
  return Object.freeze({
    status(providerId) {
      const provider = PROVIDERS[providerId];
      if (!provider) throw new TypeError("Unsupported credential provider.");
      return { providerId, configured: Boolean(secureStore.get(provider.namespace, provider.key)) };
    },
    save(providerId, secret) {
      const provider = validateProviderSecret(providerId, secret);
      secureStore.set(provider.namespace, provider.key, secret);
      return { providerId, configured: true };
    },
    remove(providerId) {
      const provider = PROVIDERS[providerId];
      if (!provider) throw new TypeError("Unsupported credential provider.");
      secureStore.remove(provider.namespace, provider.key);
      return { providerId, configured: false };
    },
  });
}

module.exports = { createProviderCredentialManager, validateProviderSecret, PROVIDERS, MAX_SECRET_LENGTH };
