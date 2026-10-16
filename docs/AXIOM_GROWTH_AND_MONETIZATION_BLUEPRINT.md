# Axiom Growth and Monetization Blueprint

**Status:** Planning only. Nothing in this document means monetization, licensing enforcement, marketplace execution, or payment processing has been implemented.

**Product principle:** Build a useful, trusted user base before charging for Axiom or introducing paid marketplace features. Keep the core product easy to try, provider-flexible, and useful without an account or a paid Axiom plan wherever technically practical.

## Goals

- Define a future path to sustainable revenue without distracting from product quality and adoption.
- Keep user-owned model-provider choices and credentials under the user's control.
- Make future licensing verifiable without pretending offline software can provide perfect DRM.
- Create a safe, reviewable path for community extensions before considering paid distribution or creator payouts.

## 1. Future licensing and commercial-use policy

### Direction

Before implementing license checks, decide and publish the project’s source and commercial-use policy. Evaluate the proposed employee-threshold model and source-available licenses against Axiom’s actual goals. Do not describe a source-available license as open source unless it meets the Open Source Definition.

### Decisions required

- Define the threshold precisely: employee count, affiliates, contractors, subsidiaries, and how it is measured.
- Define permitted personal, educational, evaluation, internal business, redistribution, hosting, and resale use.
- Explain what happens when an organization grows past the threshold, and whether existing deployments receive a transition period.
- Decide whether the policy applies to the whole repository or only clearly identified components.
- Audit dependency licenses, bundled runtimes, trademarks, and third-party notices before selecting a license.
- Obtain legal review before publishing restrictive terms or accepting commercial license payments.

### Future technical design

If a paid license is eventually needed, use a versioned, schema-validated license document with a digital signature. Keep signing private keys outside the app and repository; embed only the verification public key. Prefer a modern signature scheme such as Ed25519 unless compatibility requirements justify another choice.

Define expiry, grace periods, product edition, licensee, and any seat or organization claims explicitly. A signed `seats` field does not enforce seats by itself. Document offline limitations, clock manipulation, revocation delays, and the fact that a local application can be patched. Treat signatures as a way to detect forged license documents, not as unbreakable DRM.

### Adoption gate

Do not add license enforcement until the team has validated the license model with real users and obtained legal review. Until then, keep licensing as a documented decision, not a runtime gate.

## 2. Bring-your-own-key (BYOK) and provider routing

### Direction

BYOK should remain a first-class way to use Axiom, not a premium-only feature. Users should be able to choose supported providers and understand which endpoint receives their requests.

### Future technical design

- Use explicit provider adapters and validated configuration rather than treating a provider label or arbitrary URL as a complete integration.
- Validate custom endpoint schemes and hosts, require HTTPS for remote endpoints by default, and make loopback HTTP an explicit local-development exception.
- Never log API keys or include them in diagnostics, crash reports, or exported project data.
- Use Electron’s OS-backed secure storage where available. If secure storage is unavailable, fail safely or require session-only credentials rather than silently writing secrets in plaintext.
- Keep credentials out of renderer-accessible general-purpose storage and pass them to the runtime through a narrow, auditable boundary.
- Show the active provider, model, endpoint, and routing status without revealing secrets.
- Make local routers such as OmniRoute optional. Direct providers and compatible local endpoints must continue to work without them.
- Document that provider usage can incur charges and that provider data handling is governed by that provider’s terms.

### Adoption gate

Prioritize reliability, clear setup, and provider transparency now. Do not introduce Axiom subscriptions or lock basic BYOK behind a paid tier as part of this blueprint.

## 3. Static extension catalog and constrained installer

### Direction

A GitHub-hosted catalog can be a low-cost starting point for discovering community extensions. Treat it as a discovery mechanism first, not permission to execute arbitrary third-party code.

### Future technical design

- Publish a versioned catalog schema with stable extension IDs, version numbers, source URLs, compatibility ranges, publisher identity, permissions, and integrity metadata.
- Verify downloads against a trusted, signed release manifest. A checksum from a mutable catalog alone does not establish publisher authenticity.
- Replace shell-interpolated archive commands with argument-safe process invocation or a maintained archive library.
- Reject archive entries that escape the target directory, contain unsafe absolute paths, or exploit symlinks/hard links. Extract into a temporary staging directory, validate the result, then atomically move it into the extension directory.
- Handle download and extraction completion with awaited operations, explicit timeouts, cancellation, and cleanup of partial files.
- Keep extensions in a dedicated directory, restrict filesystem permissions where possible, and define a narrow extension API with explicit permissions.
- Do not auto-run newly installed extension code. Require user confirmation before enabling an extension and show its publisher, requested permissions, version, and source.
- Provide uninstall, disable, and recovery paths. Plan for malicious, abandoned, and compromised extensions.
- Start with a manually reviewed allowlist or curated catalog. Establish a reporting and takedown process before opening submissions broadly.

### Adoption gate

First validate demand for extensions and define the extension API and trust model. Begin with discovery and manually reviewed free extensions. Do not introduce paid extensions until installation safety, publisher identity, moderation, and support responsibilities are established.

## 4. Future marketplace revenue share and creator payouts

### Direction

A possible future marketplace could share revenue with extension creators. A proposed 90/10 split can be evaluated later, but it is a business hypothesis, not a current promise or feature.

### Decisions required

- Define whether the platform fee is calculated before or after payment processing, taxes, refunds, chargebacks, and currency conversion.
- Decide who is the seller of record and who handles customer support, refunds, consumer rights, and tax reporting.
- Define creator eligibility, identity verification, payout countries, minimum payout amounts, payout schedule, and dispute handling.
- Publish marketplace terms, prohibited content, intellectual-property rules, privacy disclosures, and an abuse-reporting process.
- Model the operational costs of payment processing, compliance, moderation, fraud, and support before committing to a revenue split.

### Future technical design

Payment links alone do not implement creator payouts. A marketplace payout system would require a supported marketplace payment arrangement (for example, a properly configured connected-account product), onboarding and verification, payment and refund webhooks, an auditable ledger, idempotent processing, reconciliation, and operational handling for failed payouts and disputes.

Do not collect or store raw payment-card data. Use the payment provider’s hosted or tokenized flows. Keep secrets and webhook signing keys on a trusted server-side service, not in the desktop app or static GitHub catalog.

### Adoption gate

Do not build payment processing or promise a creator revenue share until there is demonstrated user demand, a safe extension ecosystem, a viable legal and tax model, and enough marketplace activity to justify the operational burden.

## Recommended sequence

1. **Grow and learn:** improve onboarding, runtime reliability, project outcomes, documentation, and feedback collection. Measure activation, successful first task, repeat use, and retention without making payment a prerequisite.
2. **Validate policy:** research licensing and commercial-use options; obtain legal review. Keep this work in documentation while the product finds its audience.
3. **Harden provider setup:** improve provider adapters, secret handling, endpoint validation, and routing diagnostics as product-quality work, independent of monetization.
4. **Design extension safety:** define the manifest, trust model, permission boundary, and safe installer. Test with reviewed free extensions first.
5. **Validate marketplace demand:** talk to users and creators, estimate moderation/support costs, and test whether paid extensions solve a real problem.
6. **Only then consider payments:** settle terms, legal/tax responsibilities, refunds, payout operations, and economics before implementation.

## Adoption-first guardrails

- No subscription wall for basic project creation or BYOK as a result of this blueprint.
- No license enforcement, paid marketplace, creator payouts, or payment SDK is being introduced by this document.
- Do not ship arbitrary extension execution merely because a catalog entry has a checksum.
- Do not claim offline license enforcement or local DRM is tamper-proof.
- Do not promise a 90/10 creator split until its calculation and operational responsibilities are documented.
- Revisit this plan using user feedback and adoption data, not just the availability of a payment API.

## Success criteria before monetization work begins

The team should agree on concrete thresholds rather than inventing them after the fact. At minimum, review:

- A stable first-run and provider-setup experience.
- Reliable completion and review of a user’s first meaningful project task.
- Evidence of repeat usage and retention across multiple cohorts.
- A clear support and feedback loop for active users.
- Demonstrated demand for the proposed paid value, backed by interviews or usage evidence.
- A security and legal review for whichever monetization surface is being considered.

These criteria are intentionally not assigned numeric targets yet. Set targets after collecting a baseline from real users, rather than choosing impressive-looking numbers by staring at a spreadsheet until it agrees.
