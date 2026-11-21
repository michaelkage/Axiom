"use strict";

function validateBrowserNavigation(value) {
  if (typeof value !== "string" || value.length > 4096 || !value.trim()) {
    throw new TypeError("Enter a valid HTTP or HTTPS URL.");
  }
  let parsed;
  try { parsed = new URL(value.trim()); }
  catch { throw new TypeError("Enter a complete URL, including http:// or https://."); }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("Axiom Browser only permits HTTP/HTTPS URLs without embedded credentials.");
  }
  return parsed.href;
}

module.exports = { validateBrowserNavigation };
