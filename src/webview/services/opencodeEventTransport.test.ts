import { describe, expect, it, vi } from "vitest";
import { createOpenCodeEventSubscriber } from "./opencodeEventTransport";

describe("createOpenCodeEventSubscriber", () => {
  it("builds a directory-scoped event URL and parses typed event payloads", () => {
    const openStream = vi.fn((_url, _message, _error, _status) => () => undefined);
    const reportError = vi.fn();
    const subscriber = createOpenCodeEventSubscriber<{ type: string }>(
      () => ({ serverUrl: "http://127.0.0.1:4096/base", workspaceRoot: "/workspace" }),
      openStream,
      reportError,
    );
    const onEvent = vi.fn();
    const stop = subscriber(onEvent, undefined, "/worker/tree");
    const url = new URL(openStream.mock.calls[0][0]);
    expect(url.pathname).toBe("/event");
    expect(url.searchParams.get("directory")).toBe("/worker/tree");
    openStream.mock.calls[0][1]('{"type":"session.idle"}');
    expect(onEvent).toHaveBeenCalledWith({ type: "session.idle" });
    expect(stop).toBe(openStream.mock.results[0].value);
  });

  it("reports malformed payloads without throwing into the event source", () => {
    const openStream = vi.fn((_url, _message) => () => undefined);
    const reportError = vi.fn();
    const subscriber = createOpenCodeEventSubscriber(() => ({ serverUrl: "http://localhost:4096" }), openStream, reportError);
    subscriber(vi.fn());
    expect(() => openStream.mock.calls[0][1]("{")).not.toThrow();
    expect(reportError).toHaveBeenCalledWith("[SSE] Failed to parse runtime event.", expect.any(Error));
  });

  it("requires a connected runtime", () => {
    const openStream = vi.fn();
    const subscriber = createOpenCodeEventSubscriber(() => ({}), openStream);
    expect(() => subscriber(vi.fn())).toThrow(/not connected/i);
    expect(openStream).not.toHaveBeenCalled();
  });
});
