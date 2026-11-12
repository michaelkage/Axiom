const MAX_CONFIG_BYTES = 32 * 1024;
const SAFE_COMMAND = /^[a-zA-Z0-9_./:@=+,-]+(?:\\s+[a-zA-Z0-9_./:@=+,-]+)*$/;

export function validateProjectConfig(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError(".axiom/project.json must be a JSON object.");
  const serialized = JSON.stringify(input);
  if (new TextEncoder().encode(serialized).byteLength > MAX_CONFIG_BYTES) throw new Error("Project config exceeds 32 KiB.");
  if (input.schemaVersion !== 1) throw new Error("Unsupported .axiom project config version.");
  const conventions = Array.isArray(input.conventions) ? input.conventions : [];
  if (conventions.length > 40 || conventions.some(item => typeof item !== "string" || item.length > 500)) throw new Error("Project conventions must contain at most 40 short strings.");
  const skills = Array.isArray(input.skills) ? input.skills : [];
  if (skills.length > 30 || skills.some(id => typeof id !== "string" || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(id))) throw new Error("Project skills contain an invalid skill ID.");
  const qualityGates = Array.isArray(input.qualityGates) ? input.qualityGates : [];
  if (qualityGates.length > 20 || qualityGates.some(gate => !gate || typeof gate !== "object" || typeof gate.name !== "string" || !gate.name.trim() || gate.name.length > 80 || typeof gate.command !== "string" || !SAFE_COMMAND.test(gate.command) || gate.command.length > 500)) {
    throw new Error("Quality gates must have a short name and a simple, validated command string.");
  }
  return {
    schemaVersion: 1,
    conventions: [...conventions],
    skills: [...new Set(skills)],
    qualityGates: qualityGates.map(gate => ({ name: gate.name.trim(), command: gate.command.trim() }))
  };
}

export { MAX_CONFIG_BYTES };
