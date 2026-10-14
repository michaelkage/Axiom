import { describe, expect, it } from "vitest";
import { groupChangeTopics, toUnifiedDiff } from "./changeTopics";
describe("groupChangeTopics", () => {
  it("groups files into readable topics and totals changes", () => {
    const topics = groupChangeTopics([{ file: "src/App.tsx", additions: 4, deletions: 1 }, { file: "src/App.css", additions: 2, deletions: 0 }, { file: "src/App.test.tsx", additions: 3, deletions: 0 }]);
    expect(topics).toHaveLength(3);
    expect(topics.find(topic => topic.title === "Updated interface behavior")?.additions).toBe(4);
    expect(topics.some(topic => topic.title === "Added or updated tests")).toBe(true);
  });
  it("creates a reviewable basic unified diff", () => {
    expect(toUnifiedDiff({ file: "a.txt", before: "old", after: "new" })).toContain("-old\n+new");
  });
});
