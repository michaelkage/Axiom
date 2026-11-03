import { test, expect } from "./fixtures";

test.describe("Prompt Sending", () => {
  test("should show input textarea and submit button", async ({ openWebview }) => {
    const page = await openWebview();
    
    await expect(page.getByRole("textbox", { name: "Message input" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Submit" })).toBeVisible();
  });

  test("submit button should be disabled when input is empty", async ({ openWebview }) => {
    const page = await openWebview();
    
    const submitButton = page.getByRole("button", { name: "Submit" });
    await expect(submitButton).toBeDisabled();
  });

  test("submit button should be enabled when input has text", async ({ openWebview }) => {
    const page = await openWebview();
    
    const textarea = page.getByRole("textbox", { name: "Message input" });
    await textarea.fill("Hello, OpenCode!");
    
    const submitButton = page.getByRole("button", { name: "Submit" });
    await expect(submitButton).toBeEnabled();
  });
  test("welcome suggestion populates the composer without sending", async ({ openWebview }) => {
    const page = await openWebview();

    const suggestion = page.getByRole("button", { name: /Launch a landing page/ });
    await expect(suggestion).toBeVisible();
    await suggestion.click();

    const editor = page.getByRole("textbox", { name: "Message input" });
    await expect(editor).toContainText("Build a polished, responsive landing page");
    await expect(page.getByRole("article", { name: "user message" })).toHaveCount(0);
  });

});
