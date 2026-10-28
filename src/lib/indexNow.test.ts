import { describe, expect, it, vi } from "vitest";
import { submitIndexNow } from "./indexNow.js";

describe("submitIndexNow", () => {
  it("submits unique canonical URLs with the root verification key", async () => {
    let requestBody = "";
    const fetcher: typeof fetch = async (_input, init) => {
      requestBody = String(init?.body);
      return new Response(null, { status: 200 });
    };
    const log = { warn: vi.fn() };

    await submitIndexNow(
      [
        "https://sanctyria.com/p/example",
        "https://sanctyria.com/p/example",
        "https://example.com/not-ours",
      ],
      "test-key-123",
      log,
      fetcher,
    );

    expect(JSON.parse(requestBody)).toEqual({
      host: "sanctyria.com",
      key: "test-key-123",
      keyLocation: "https://sanctyria.com/test-key-123.txt",
      urlList: ["https://sanctyria.com/p/example"],
    });
    expect(log.warn).toHaveBeenCalledOnce();
  });

  it("logs rejected IndexNow responses", async () => {
    const fetcher: typeof fetch = async () => new Response(null, { status: 403 });
    const log = { warn: vi.fn() };

    await submitIndexNow(
      ["https://sanctyria.com/p/example"],
      "test-key-123",
      log,
      fetcher,
    );

    expect(log.warn).toHaveBeenCalledWith(
      { statusCode: 403, urlCount: 1 },
      "IndexNow rejected URL notifications",
    );
  });
});
