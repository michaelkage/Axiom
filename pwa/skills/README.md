# Axiom Skills

Axiom skills use a versioned JSON manifest plus a SKILL.md instruction file.

## Layout

```text
pwa/skills/
  registry.json
  skill.schema.json
  official/
    your-skill/
      skill.json
      SKILL.md
```

## Manifest

Validate against [skill.schema.json](./skill.schema.json). Required fields:

- schemaVersion: currently 1
- id: lowercase slug, 2–64 characters
- name, version (SemVer), and description
- requiredTools: exact Axiom tool names the skill expects
- modelHints: advisory model capability hints
- permissions: declared safety requirements, not capability grants
- instructionsUrl: relative or absolute URL to the Markdown instructions

Instructions are limited to 20,000 characters. Remote manifests and instruction files must be served over HTTPS. Custom URLs are fetched only after the user explicitly inspects them.

## Safety model

Skills are treated as untrusted prompt guidance. They cannot register tools, grant filesystem/network/shell access, override system instructions, or bypass Axiom's existing approval prompts. Missing required tools are disclosed in the task prompt. Tool permissions remain controlled by Axiom's existing registry and approval system.

## Publish

1. Add a folder under official/<skill-id>/ containing skill.json and SKILL.md.
2. Validate the manifest against skill.schema.json.
3. Add an entry to registry.json.
4. Open a pull request with a clear description of the skill's behavior, declared permissions, and example use cases.

Users can also install a custom HTTPS skill.json URL after inspecting the manifest and full instructions.