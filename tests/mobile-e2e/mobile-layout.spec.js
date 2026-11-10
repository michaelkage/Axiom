import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
  await page.route("**/api/tags", route => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ models: [{ name: "qwen2.5:1.5b" }] }),
  }));
});

test("keeps the chat composer and navigation reachable without horizontal overflow", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Your local copilot." })).toBeVisible();

  const composer = page.getByRole("textbox", { name: "Message your local model" });
  const nav = page.getByRole("navigation");
  await expect(composer).toBeVisible();
  await expect(nav).toBeVisible();

  const dimensions = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
  }));
  expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport);

  await composer.focus();
  await page.setViewportSize({ width: 360, height: 520 });
  const composerBox = await composer.boundingBox();
  const navBox = await nav.boundingBox();
  expect(composerBox).not.toBeNull();
  expect(navBox).not.toBeNull();
  expect(composerBox.y + composerBox.height).toBeLessThanOrEqual(520);
  expect(navBox.y + navBox.height).toBeLessThanOrEqual(520);
});

test("switches between all primary mobile sections", async ({ page }) => {
  await page.goto("/");
  for (const [label, heading] of [
    ["Tools", "Tool registry"],
    ["MCP", "MCP servers"],
    ["Logs", "Execution logs"],
    ["Chat", "Your local copilot."],
  ]) {
    await page.getByRole("button", { name: label, exact: true }).click();
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();
  }
});

test("sends a chat turn through the streaming Ollama endpoint", async ({ page }) => {
  await page.route("**/api/chat", route => route.fulfill({
    status: 200,
    contentType: "application/x-ndjson",
    body: JSON.stringify({ message: { role: "assistant", content: "Browser test reply" }, done: true }) + "\n",
  }));
  await page.goto("/");
  await page.getByRole("textbox", { name: "Message your local model" }).fill("Say hello");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText("Browser test reply")).toBeVisible();
  await expect(page.getByText("Say hello")).toBeVisible();
});

test("cancels an in-flight mobile chat request from the stop control", async ({ page }) => {
  await page.route("**/api/chat", async route => {
    await new Promise(resolve => setTimeout(resolve, 600));
    try {
      await route.fulfill({
        status: 200,
        contentType: "application/x-ndjson",
        body: JSON.stringify({ message: { role: "assistant", content: "This should not arrive" }, done: true }) + "\\n",
      });
    } catch {
      // The browser may already have aborted the request after Stop was pressed.
    }
  });

  await page.goto("/");
  await page.getByRole("textbox", { name: "Message your local model" }).fill("Start a long response");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByRole("button", { name: "Stop generation" }).first()).toBeVisible();
  await page.getByRole("button", { name: "Stop generation" }).first().click();

  await expect(page.getByText("Generation stopped.")).toBeVisible();
  await expect(page.getByText("This should not arrive")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Send message" })).toBeVisible();
});
