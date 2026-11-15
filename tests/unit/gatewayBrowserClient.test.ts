import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GatewayBrowserClient } from "@/lib/gateway/openclaw/GatewayBrowserClient";

const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];
  static sent: string[] = [];
  static closes: Array<{ code: number; reason: string }> = [];

  readyState = MockWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
  }

  send(data: string) {
    MockWebSocket.sent.push(String(data));
  }

  close(code?: number, reason?: string) {
    MockWebSocket.closes.push({ code: code ?? 1000, reason: reason ?? "" });
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code: code ?? 1000, reason: reason ?? "" } as CloseEvent);
  }
}

describe("GatewayBrowserClient", () => {
  const originalWebSocket = globalThis.WebSocket;
  const originalSubtle = globalThis.crypto?.subtle;

  beforeEach(() => {
    MockWebSocket.instances = [];
    MockWebSocket.sent = [];
    MockWebSocket.closes = [];
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
    if (globalThis.crypto) {
      Object.defineProperty(globalThis.crypto, "subtle", {
        value: undefined,
        configurable: true,
      });
    }
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.WebSocket = originalWebSocket;
    if (globalThis.crypto) {
      Object.defineProperty(globalThis.crypto, "subtle", {
        value: originalSubtle,
        configurable: true,
      });
    }
  });

  it("sends connect when connect.challenge arrives", async () => {
    const client = new GatewayBrowserClient({ url: "ws://example.com" });
    client.start();

    const ws = MockWebSocket.instances[0];
    if (!ws) {
      throw new Error("WebSocket not created");
    }

    ws.onopen?.();

    expect(MockWebSocket.sent).toHaveLength(0);

    ws.onmessage?.({
      data: JSON.stringify({
        type: "event",
        event: "connect.challenge",
        payload: { nonce: "abc" },
      }),
    } as MessageEvent);

    await vi.runAllTicks();

    expect(MockWebSocket.sent).toHaveLength(1);
    const frame = JSON.parse(MockWebSocket.sent[0] ?? "{}");
    expect(frame.type).toBe("req");
    expect(frame.method).toBe("connect");
    expect(typeof frame.id).toBe("string");
    expect(frame.id).toMatch(UUID_V4_RE);
    expect(frame.params?.client?.id).toBe("openclaw-control-ui");
  });

  it("truncates connect-failed close reason to websocket limit", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = new GatewayBrowserClient({ url: "ws://example.com", token: "secret" });
    client.start();

    const ws = MockWebSocket.instances[0];
    if (!ws) {
      throw new Error("WebSocket not created");
    }

    ws.onopen?.();
    vi.runAllTimers();

    const connectFrame = JSON.parse(MockWebSocket.sent[0] ?? "{}");
    const connectId = String(connectFrame.id ?? "");
    expect(connectId).toMatch(UUID_V4_RE);

    ws.onmessage?.({
      data: JSON.stringify({
        type: "res",
        id: connectId,
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          message: `invalid config ${"x".repeat(260)}`,
        },
      }),
    } as MessageEvent);

    await vi.runAllTicks();
    await vi.runAllTimersAsync();
    await Promise.resolve();

    const lastClose = MockWebSocket.closes.at(-1);
    expect(lastClose?.code).toBe(4008);
    expect(lastClose?.reason.startsWith("connect failed: INVALID_REQUEST")).toBe(true);
    expect(new TextEncoder().encode(lastClose?.reason ?? "").byteLength).toBeLessThanOrEqual(123);
    warnSpy.mockRestore();
  });

  it("sends the dev buildId sentinel for the control-ui client id", async () => {
    const client = new GatewayBrowserClient({ url: "ws://example.com" });
    client.start();

    const ws = MockWebSocket.instances[0];
    if (!ws) {
      throw new Error("WebSocket not created");
    }

    ws.onopen?.();
    vi.runAllTimers();

    const frame = JSON.parse(MockWebSocket.sent[0] ?? "{}");
    expect(frame.method).toBe("connect");
    expect(frame.params?.client?.id).toBe("openclaw-control-ui");
    expect(frame.params?.client?.buildId).toBe("dev");
  });

  it("omits buildId for non control-ui client ids", async () => {
    const client = new GatewayBrowserClient({
      url: "ws://example.com",
      clientName: "openclaw-webchat",
    });
    client.start();

    const ws = MockWebSocket.instances[0];
    if (!ws) {
      throw new Error("WebSocket not created");
    }

    ws.onopen?.();
    vi.runAllTimers();

    const frame = JSON.parse(MockWebSocket.sent[0] ?? "{}");
    expect(frame.params?.client?.id).toBe("openclaw-webchat");
    expect(frame.params?.client).not.toHaveProperty("buildId");
  });

  it("retries connect without buildId when an older gateway rejects it", async () => {
    const onHello = vi.fn();
    const client = new GatewayBrowserClient({ url: "ws://example.com", onHello });
    client.start();

    const ws = MockWebSocket.instances[0];
    if (!ws) {
      throw new Error("WebSocket not created");
    }

    ws.onopen?.();
    vi.runAllTimers();

    expect(MockWebSocket.sent).toHaveLength(1);
    const first = JSON.parse(MockWebSocket.sent[0] ?? "{}");
    expect(first.params?.client?.buildId).toBe("dev");

    // Older gateways (< 2026.8) reject unknown client properties.
    ws.onmessage?.({
      data: JSON.stringify({
        type: "res",
        id: first.id,
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          message: "invalid connect params: client.buildId is not an allowed property",
        },
      }),
    } as MessageEvent);
    await vi.runAllTicks();

    expect(MockWebSocket.sent).toHaveLength(2);
    const second = JSON.parse(MockWebSocket.sent[1] ?? "{}");
    expect(second.id).not.toBe(first.id);
    expect(second.params?.client?.id).toBe("openclaw-control-ui");
    expect(second.params?.client).not.toHaveProperty("buildId");

    ws.onmessage?.({
      data: JSON.stringify({
        type: "res",
        id: second.id,
        ok: true,
        payload: { type: "hello-ok", protocol: 4 },
      }),
    } as MessageEvent);
    await vi.runAllTicks();

    expect(MockWebSocket.closes).toHaveLength(0);
    expect(onHello).toHaveBeenCalledTimes(1);
  });

  it("does not retry without buildId for unrelated connect errors", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = new GatewayBrowserClient({ url: "ws://example.com", token: "secret" });
    client.start();

    const ws = MockWebSocket.instances[0];
    if (!ws) {
      throw new Error("WebSocket not created");
    }

    ws.onopen?.();
    vi.runAllTimers();

    const first = JSON.parse(MockWebSocket.sent[0] ?? "{}");
    expect(first.params?.client?.buildId).toBe("dev");

    // The error does not name buildId, so no fallback retry is attempted.
    ws.onmessage?.({
      data: JSON.stringify({
        type: "res",
        id: first.id,
        ok: false,
        error: { code: "INVALID_REQUEST", message: "invalid connect params" },
      }),
    } as MessageEvent);
    await vi.runAllTicks();

    expect(MockWebSocket.sent).toHaveLength(1);
    expect(MockWebSocket.closes.at(-1)?.code).toBe(4008);
    warnSpy.mockRestore();
  });

  it("does not retry without buildId for non-gateway errors", async () => {
    const client = new GatewayBrowserClient({ url: "ws://example.com" });
    client.start();

    const ws = MockWebSocket.instances[0];
    if (!ws) {
      throw new Error("WebSocket not created");
    }

    ws.onopen?.();
    vi.runAllTimers();

    // A response frame without an error code rejects with a plain Error, not a
    // GatewayResponseError. Even with buildId in the message, the fallback only
    // applies to gateway rejections that name the property.
    const first = JSON.parse(MockWebSocket.sent[0] ?? "{}");
    ws.onmessage?.({
      data: JSON.stringify({
        type: "res",
        id: first.id,
        ok: false,
        error: { message: "client.buildId rejected by proxy" },
      }),
    } as MessageEvent);
    await vi.runAllTicks();

    expect(MockWebSocket.sent).toHaveLength(1);
    expect(MockWebSocket.closes.at(-1)?.code).toBe(4008);
  });

  it("retries without buildId when the property is named in string details", async () => {
    const client = new GatewayBrowserClient({ url: "ws://example.com" });
    client.start();

    const ws = MockWebSocket.instances[0];
    if (!ws) {
      throw new Error("WebSocket not created");
    }

    ws.onopen?.();
    vi.runAllTimers();

    const first = JSON.parse(MockWebSocket.sent[0] ?? "{}");
    ws.onmessage?.({
      data: JSON.stringify({
        type: "res",
        id: first.id,
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          message: "invalid connect params",
          details: "client.buildId is not an allowed property",
        },
      }),
    } as MessageEvent);
    await vi.runAllTicks();

    expect(MockWebSocket.sent).toHaveLength(2);
    const second = JSON.parse(MockWebSocket.sent[1] ?? "{}");
    expect(second.params?.client).not.toHaveProperty("buildId");
  });

  it("retries without buildId when the property is named in structured details", async () => {
    const client = new GatewayBrowserClient({ url: "ws://example.com" });
    client.start();

    const ws = MockWebSocket.instances[0];
    if (!ws) {
      throw new Error("WebSocket not created");
    }

    ws.onopen?.();
    vi.runAllTimers();

    const first = JSON.parse(MockWebSocket.sent[0] ?? "{}");
    ws.onmessage?.({
      data: JSON.stringify({
        type: "res",
        id: first.id,
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          message: "invalid connect params",
          details: { errors: ["client.buildId is not an allowed property"] },
        },
      }),
    } as MessageEvent);
    await vi.runAllTicks();

    expect(MockWebSocket.sent).toHaveLength(2);
    const second = JSON.parse(MockWebSocket.sent[1] ?? "{}");
    expect(second.params?.client).not.toHaveProperty("buildId");
  });

  it("stops sending buildId after an older gateway rejected it", async () => {
    const client = new GatewayBrowserClient({ url: "ws://example.com" });
    client.start();

    const ws = MockWebSocket.instances[0];
    if (!ws) {
      throw new Error("WebSocket not created");
    }

    ws.onopen?.();
    vi.runAllTimers();

    const first = JSON.parse(MockWebSocket.sent[0] ?? "{}");
    expect(first.params?.client?.buildId).toBe("dev");

    ws.onmessage?.({
      data: JSON.stringify({
        type: "res",
        id: first.id,
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          message: "invalid connect params: client.buildId is not an allowed property",
        },
      }),
    } as MessageEvent);
    await vi.runAllTicks();

    const second = JSON.parse(MockWebSocket.sent[1] ?? "{}");
    expect(second.params?.client).not.toHaveProperty("buildId");

    // The buildId-less retry is rejected too, so the connect fails and the
    // client closes and reconnects.
    ws.onmessage?.({
      data: JSON.stringify({
        type: "res",
        id: second.id,
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          message: "invalid connect params: client.buildId is not an allowed property",
        },
      }),
    } as MessageEvent);
    await vi.runAllTicks();

    expect(MockWebSocket.closes.at(-1)?.code).toBe(4008);
    expect(MockWebSocket.instances).toHaveLength(1);

    await vi.runAllTimersAsync();
    const reconnected = MockWebSocket.instances[1];
    if (!reconnected) {
      throw new Error("reconnect socket not created");
    }
    reconnected.onopen?.();
    await vi.runAllTimersAsync();

    const frames = MockWebSocket.sent.map((raw) => JSON.parse(raw));
    const reconnectFrame = frames.at(-1);
    expect(reconnectFrame?.method).toBe("connect");
    expect(reconnectFrame?.params?.client).not.toHaveProperty("buildId");
  });
});
