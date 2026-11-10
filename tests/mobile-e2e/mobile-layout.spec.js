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


test("exposes integration switches and reports missing credentials", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Tools", exact: true }).click();

  const github = page.getByRole("switch", { name: "Enable GitHub integration" });
  await expect(github).toHaveAttribute("aria-checked", "false");
  await github.click();
  await expect(page.getByText("A GitHub Personal Access Token is required.")).toBeVisible();
  await expect(github).toHaveAttribute("aria-checked", "false");

  const supabase = page.getByRole("switch", { name: "Enable Supabase integration" });
  await expect(supabase).toHaveAttribute("aria-checked", "false");
  await supabase.click();
  await expect(page.getByText("A Supabase project URL and API key are required.")).toBeVisible();
  await expect(supabase).toHaveAttribute("aria-checked", "false");
});


test("copies the custom tool starter as readable multiline source", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByRole("button", { name: "Copy custom tool template" }).click();

  const expected = [
    "import { registerTool } from './lib/toolRegistry.js';",
    "",
    "registerTool({",
    "  name: 'my_custom_tool',",
    "  description: 'Describe what this tool does',",
    "  inputSchema: { type: 'object', properties: {}, additionalProperties: false }",
    "}, async (input) => {",
    "  // Implement your async capability here",
    "  return { ok: true };",
    "});",
  ].join("\\n");
  await expect(page.getByText("Custom tool template copied.")).toBeVisible();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(expected);
});

test("adds and removes an MCP endpoint from the mobile server manager", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "MCP", exact: true }).click();

  await page.getByRole("textbox", { name: "Server name" }).fill("Local test server");
  await page.getByRole("textbox", { name: "Endpoint URL" }).fill("https://mcp.example.com/mcp");
  await page.getByRole("button", { name: "Add server" }).click();

  await expect(page.getByText("Local test server")).toBeVisible();
  await expect(page.getByText("https://mcp.example.com/mcp")).toBeVisible();
  await expect(page.getByRole("button", { name: "Reconnect Local test server" })).toBeVisible();
  await page.getByRole("button", { name: "Remove Local test server" }).click();
  await expect(page.getByText("Local test server")).toHaveCount(0);
  await expect(page.getByText("No MCP servers connected yet.")).toBeVisible();
});

test("clears execution logs using the labelled mobile action", async ({ page }) => {
  await page.route("**/api/chat", route => route.fulfill({
    status: 200,
    contentType: "application/x-ndjson",
    body: JSON.stringify({ message: { role: "assistant", content: "Log this reply" }, done: true }) + "\n",
  }));
  await page.goto("/");
  await page.getByRole("textbox", { name: "Message your local model" }).fill("Create execution events");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText("Log this reply")).toBeVisible();

  await page.getByRole("button", { name: "Logs", exact: true }).click();
  await expect(page.getByText("Ollama /api/chat")).toBeVisible();
  await page.getByRole("button", { name: "Clear execution logs" }).click();
  await expect(page.getByText("No execution events yet.")).toBeVisible();
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
        body: JSON.stringify({ message: { role: "assistant", content: "This should not arrive" }, done: true }) + "\n",
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


test("keeps streamed output attached to its originating chat when history changes", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("axiom.mobile.v1", JSON.stringify({
      activeTab: "chat",
      chats: [
        { id: "chat-running", title: "Running conversation", messages: [] },
        { id: "chat-other", title: "Other conversation", messages: [
          { id: "other-message", role: "user", content: "This is another chat", time: "10:00" }
        ] }
      ]
    }));
  });
  await page.route("**/api/chat", async route => {
    await new Promise(resolve => setTimeout(resolve, 350));
    await route.fulfill({
      status: 200,
      contentType: "application/x-ndjson",
      body: JSON.stringify({ message: { role: "assistant", content: "Reply belongs to running chat" }, done: true }) + "\n",
    });
  });

  await page.goto("/");
  await page.getByRole("textbox", { name: "Message your local model" }).fill("Keep this response with this chat");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByRole("button", { name: "Stop generation" }).first()).toBeVisible();
  await page.getByRole("button", { name: "History" }).click();
  await page.getByRole("button", { name: /Other conversation/ }).click();
  await expect(page.getByText("This is another chat")).toBeVisible();
  await expect(page.getByText("Reply belongs to running chat")).toHaveCount(0);

  await expect(page.getByRole("button", { name: "History" })).toBeVisible();
  await page.getByRole("button", { name: "History" }).click();
  await page.getByRole("button", { name: /Running conversation/ }).click();
  await expect(page.getByText("Reply belongs to running chat")).toBeVisible();
});

test("keeps generation cancellation available after navigating away from chat", async ({ page }) => {
  await page.route("**/api/chat", async route => {
    await new Promise(resolve => setTimeout(resolve, 700));
    try {
      await route.fulfill({
        status: 200,
        contentType: "application/x-ndjson",
        body: JSON.stringify({ message: { role: "assistant", content: "Late response must stay cancelled" }, done: true }) + "\n",
      });
    } catch {
      // Stop may abort the browser request before the mock response is fulfilled.
    }
  });

  await page.goto("/");
  await page.getByRole("textbox", { name: "Message your local model" }).fill("Start then navigate");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByRole("button", { name: "Stop generation" }).first()).toBeVisible();
  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Tool registry" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop generation" }).first()).toBeVisible();
  await page.getByRole("button", { name: "Stop generation" }).first().click();
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await expect(page.getByText("Generation stopped.")).toBeVisible();
  await expect(page.getByText("Late response must stay cancelled")).toHaveCount(0);
});


test("supports Shift+Enter for newlines and Enter to send on mobile chat", async ({ page }) => {
  await page.route("**/api/chat", route => route.fulfill({
    status: 200,
    contentType: "application/x-ndjson",
    body: JSON.stringify({ message: { role: "assistant", content: "Keyboard submission worked" }, done: true }) + "\n",
  }));

  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "Message your local model" });
  await composer.fill("First line");
  await composer.press("Shift+Enter");
  await composer.type("Second line");
  await expect(composer).toHaveValue("First line\nSecond line");
  await composer.press("Enter");

  await expect(page.getByText("Keyboard submission worked")).toBeVisible();
  await expect(page.getByText("First line\nSecond line")).toBeVisible();
  await expect(composer).toHaveValue("");
});


test("renders assistant Markdown headings, lists, inline formatting, links and fenced code safely", async ({ page }) => {
  const markdown = [
    "## Build summary",
    "",
    "This is **bold** with `inlineCode()` and *emphasis*.",
    "",
    "- First capability",
    "- Second capability",
    "",
    "1. Validate input",
    "2. Execute safely",
    "",
    "> Keep the output readable.",
    "",
    "| Feature | Status |",
    "| --- | --- |",
    "| Markdown | **Ready** |",
    "",
    "---",
    "",
    "```js",
    "const answer = 42;",
    "console.log(answer);",
    "```",
    "",
    "[Project docs](https://example.com/docs)",
    "",
    "<script>window.markdownXss = true</script>",
  ].join("\n");

  await page.route("**/api/chat", route => route.fulfill({
    status: 200,
    contentType: "application/x-ndjson",
    body: JSON.stringify({ message: { role: "assistant", content: markdown }, done: true }) + "\n",
  }));

  await page.goto("/");
  await page.getByRole("textbox", { name: "Message your local model" }).fill("Show formatted output");
  await page.getByRole("button", { name: "Send message" }).click();

  await expect(page.getByRole("heading", { name: "Build summary" })).toBeVisible();
  await expect(page.locator("strong", { hasText: "bold" })).toBeVisible();
  await expect(page.locator("em", { hasText: "emphasis" })).toBeVisible();
  await expect(page.locator("code", { hasText: "inlineCode()" })).toBeVisible();
  await expect(page.locator("ul li")).toHaveText(["First capability", "Second capability"]);
  await expect(page.locator("ol li")).toHaveText(["Validate input", "Execute safely"]);
  await expect(page.locator("blockquote")).toContainText("Keep the output readable.");
  await expect(page.locator("table thead th")).toHaveText(["Feature", "Status"]);
  await expect(page.locator("table tbody td")).toHaveText(["Markdown", "Ready"]);
  await expect(page.locator("hr")).toHaveCount(1);
  await expect(page.locator("pre code")).toContainText("const answer = 42;");
  await expect(page.getByRole("link", { name: "Project docs" })).toHaveAttribute("rel", "noopener noreferrer");
  await expect(page.locator(".markdown-content script")).toHaveCount(0);
  expect(await page.evaluate(() => window.markdownXss)).toBeUndefined();
});


test("copies a complete assistant response from its message actions", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const response = "## Copy-ready answer\n\nKeep every line intact.";
  await page.route("**/api/chat", route => route.fulfill({
    status: 200,
    contentType: "application/x-ndjson",
    body: JSON.stringify({ message: { role: "assistant", content: response }, done: true }) + "\n",
  }));

  await page.goto("/");
  await page.getByRole("textbox", { name: "Message your local model" }).fill("Give me a response to copy");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByRole("heading", { name: "Copy-ready answer" })).toBeVisible();
  await page.getByRole("button", { name: "Copy assistant response" }).click();

  await expect(page.getByText("Assistant response copied.")).toBeVisible();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(response);
});


test("traps focus in settings, restores focus, and closes with Escape", async ({ page }) => {
  await page.goto("/");
  const trigger = page.getByRole("button", { name: "Open settings" });
  await trigger.click();

  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  const close = page.getByRole("button", { name: "Close settings" });
  await expect(close).toBeFocused();

  await page.keyboard.press("Shift+Tab");
  const lastControl = page.getByRole("button", { name: "Test Ollama connection" });
  await expect(lastControl).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});
