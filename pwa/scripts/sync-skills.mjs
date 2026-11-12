import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSkillManifest } from '../src/lib/skillRegistry.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skillsRoot = path.join(root, 'skills');
const publicSkillsRoot = path.join(root, 'public', 'skills');
const source = JSON.parse(await readFile(path.join(skillsRoot, 'registry.json'), 'utf8'));

if (source.schemaVersion !== 1 || !Array.isArray(source.skills)) {
  throw new Error('Unsupported Axiom skill registry source format.');
}

const skills = [];
for (const entry of source.skills) {
  if (!entry || typeof entry.id !== 'string' || typeof entry.manifestUrl !== 'string') {
    throw new Error('Every registry entry must declare an ID and local manifest URL.');
  }
  if (!entry.manifestUrl.startsWith('/skills/') || entry.manifestUrl.includes('..')) {
    throw new Error('Bundled skill manifest paths must stay inside pwa/skills.');
  }
  const manifestPath = path.resolve(skillsRoot, entry.manifestUrl.slice('/skills/'.length));
  if (!manifestPath.startsWith(skillsRoot + path.sep)) throw new Error('Skill manifest path escaped the skills directory.');
  const manifest = validateSkillManifest(JSON.parse(await readFile(manifestPath, 'utf8')));
  if (manifest.id !== entry.id) throw new Error('Registry ID does not match manifest ID: ' + entry.id);
  const instructionsPath = path.resolve(path.dirname(manifestPath), manifest.instructionsUrl);
  if (!instructionsPath.startsWith(path.dirname(manifestPath) + path.sep)) throw new Error('Skill instructions must remain beside their manifest.');
  const instructions = (await readFile(instructionsPath, 'utf8')).trim();
  if (!instructions || instructions.length > 20000) throw new Error('Skill instructions are empty or exceed 20,000 characters: ' + entry.id);
  skills.push({
    id: manifest.id,
    name: manifest.name,
    description: manifest.description,
    source: String(entry.source || 'Curated'),
    manifest,
    instructions
  });
}

await mkdir(publicSkillsRoot, { recursive: true });
await writeFile(path.join(publicSkillsRoot, 'registry.json'), JSON.stringify({ schemaVersion: 1, skills }, null, 2) + '\n');
process.stdout.write('Bundled ' + skills.length + ' validated Axiom skills.\n');
