# Root-Cause Debugging

1. Reproduce the reported failure from the available evidence before changing code.
2. Follow the failing data or control path across UI, state, transport, runtime, and persistence boundaries.
3. Separate root cause from symptoms. Do not add retries, fallbacks, or swallowed errors until the failure mode is understood.
4. Inspect adjacent callers and tests to identify compatibility constraints.
5. Make the smallest production-safe change that addresses the cause.
6. Add a regression test that fails before the fix and passes after it.
7. Preserve cancellation, authentication, validation, and user approval behavior.
8. Report what was tested and what remains unverified. Never invent command output or claim a device test that did not happen.
