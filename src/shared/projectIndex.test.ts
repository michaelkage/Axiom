import { describe, expect, it } from "vitest";
import { updateProjectIndex, findProjectImpact } from "./projectIndex";
const file = (path: string, imports: string[] = []) => ({ path, size: 20, modifiedAt: 1, contentHash: "a".repeat(64), imports, symbols: [] });
describe("project index", () => {
  it("updates incrementally within project scope and computes direct impact", () => {
    const first = updateProjectIndex(null, "project-a", [file("src/a.ts"), file("src/b.ts", ["src/a.ts"])], []);
    const next = updateProjectIndex(first, "project-a", [file("src/a.ts")], ["src/b.ts"]);
    expect(next.revision).toBe(2);
    expect(findProjectImpact(first, ["src/a.ts"])).toEqual(["src/a.ts", "src/b.ts"]);
    expect(next.entries).toHaveLength(1);
  });
  it("rejects traversal, excluded folders and cross-project snapshots", () => {
    expect(() => updateProjectIndex(null, "project-a", [file("../secret")], [])).toThrow();
    expect(() => updateProjectIndex(null, "project-a", [file("node_modules/x.js")], [])).toThrow();
    const first = updateProjectIndex(null, "project-a", [], []);
    expect(() => updateProjectIndex(first, "project-b", [], [])).toThrow();
  });
});
