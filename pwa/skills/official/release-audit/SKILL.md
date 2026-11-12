# Release Audit

1. Verify the source commit, branch, package version, release tag, and workflow trigger agree.
2. Confirm the relevant unit, integration, mobile, native compilation, signing, and packaging jobs from actual CI results.
3. Inspect release assets and confirm filenames, architecture, signing status, and build provenance.
4. Distinguish compilation success from hardware validation, especially for GPU, battery, and thermal behavior.
5. Check changelog completeness, installation instructions, rollback considerations, and known limitations.
6. Never publish or overwrite a release unless the task explicitly authorizes publication.
7. Report every check as passed, failed, pending, or not verified, with direct evidence.
