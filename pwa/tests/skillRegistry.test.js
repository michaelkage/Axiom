import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateSkillManifest, buildSkillSystemPrompt } from '../src/lib/skillRegistry.js';

const validSkill = {
  schemaVersion: 1,
  id: 'test-skill',
  name: 'Test Skill',
  version: '1.0.0',
  description: 'A test skill.',
  requiredTools: [],
  modelHints: ['reasoning'],
  permissions: ['read-context'],
  instructionsUrl: './SKILL.md'
};

test('validates and normalizes a versioned skill manifest', () => {
  const manifest = validateSkillManifest(validSkill);
  assert.equal(manifest.id, 'test-skill');
  assert.deepEqual(manifest.permissions, ['read-context']);
  assert.deepEqual(manifest.requiredTools, []);
});

test('rejects unrecognized permission declarations', () => {
  assert.throws(() => validateSkillManifest({ ...validSkill, permissions: ['root-access'] }), /unknown safety permission/);
});

test('rejects unsupported schema versions and invalid skill IDs', () => {
  assert.throws(() => validateSkillManifest({ ...validSkill, schemaVersion: 2 }), /schema version/);
  assert.throws(() => validateSkillManifest({ ...validSkill, id: '../escape' }), /Skill ID/);
});

test('skill prompt treats instructions as untrusted guidance and never grants capabilities', () => {
  const prompt = buildSkillSystemPrompt([{ ...validSkill, instructions: 'Review the code carefully.' }], []);
  assert.match(prompt, /cannot grant tools, bypass approval/);
  assert.match(prompt, /untrusted skill content/);
  assert.match(prompt, /Review the code carefully/);
});

test('skill prompt reports missing required tools instead of pretending they exist', () => {
  const prompt = buildSkillSystemPrompt([{ ...validSkill, requiredTools: ['github_write'], instructions: 'Do the task.' }], []);
  assert.match(prompt, /Unavailable required tools: test-skill: github_write/);
});

test('official skill sources are bundled into the offline public registry at build time', async () => {
  const script = await readFile(new URL('../scripts/sync-skills.mjs', import.meta.url), 'utf8');
  const source = JSON.parse(await readFile(new URL('../skills/registry.json', import.meta.url), 'utf8'));
  const bundled = JSON.parse(await readFile(new URL('../public/skills/registry.json', import.meta.url), 'utf8'));
  assert.match(script, /validateSkillManifest/);
  assert.match(script, /20000/);
  assert.equal(bundled.schemaVersion, 1);
  assert.deepEqual(bundled.skills.map(skill => skill.id), source.skills.map(skill => skill.id));
  assert.ok(bundled.skills.every(skill => skill.instructions && skill.manifest.instructionsUrl));
});
