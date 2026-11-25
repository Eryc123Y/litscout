import { expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import {
  fetchPublicPdf,
  isPublicAddress,
  limitedPdf,
} from "../src/public-fetch";
const state = vi.hoisted(() => ({
  dns: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
  addresses: [] as unknown[],
  request: vi.fn(),
  fail: false,
}));
vi.mock("node:dns/promises", () => ({ lookup: state.dns }));
vi.mock("node:https", () => ({
  request: (
    _url: URL,
    options: {
      lookup: (
        host: string,
        options: { all: boolean },
        callback: (error: unknown, address: unknown, family?: unknown) => void,
      ) => void;
    },
    callback: (response: Readable) => void,
  ) => {
    state.request(options);
    let onError: (error: Error) => void = () => {};
    return {
      once: (_event: string, handler: (error: Error) => void) => {
        onError = handler;
      },
      end: () => {
        if (state.fail) {
          onError(new Error("Test TLS failure"));
          return;
        }
        options.lookup(
          "example.org",
          { all: false },
          (_error: unknown, address: unknown, family: unknown) =>
            state.addresses.push({ address, family }),
        );
        options.lookup(
          "example.org",
          { all: true },
          (_error: unknown, addresses: unknown) =>
            state.addresses.push(addresses),
        );
        const response = Object.assign(Readable.from([Buffer.from("PDF")]), {
          statusCode: 200,
          headers: {
            "content-length": "3",
            "x-values": ["one", "two"],
            "x-absent": undefined,
          },
        });
        callback(response);
      },
    };
  },
}));
it("S5 pins a checked address into the actual HTTPS adapter instead of resolving the host twice", async () => {
  state.dns.mockClear();
  state.addresses.length = 0;
  const response = await fetchPublicPdf(
    "https://example.org/paper",
    globalThis.fetch,
  );
  expect(await response.text()).toBe("PDF");
  expect(state.dns).toHaveBeenCalledOnce();
  expect(state.addresses).toEqual([
    { address: "93.184.216.34", family: 4 },
    [{ address: "93.184.216.34", family: 4 }],
  ]);
  state.fail = true;
  await expect(
    fetchPublicPdf("https://example.org/paper", globalThis.fetch),
  ).rejects.toThrow("Test TLS failure");
  state.fail = false;
});
it("S5 classifies mapped addresses, global IPv6 and invalid/nonroutable addresses", async () => {
  for (const address of ["8.8.8.8", "2606:4700:4700::1111", "::ffff:8.8.8.8"])
    expect(isPublicAddress(address)).toBe(true);
  for (const address of [
    "invalid",
    "2001:db8::1",
    "198.18.0.1",
    "224.0.0.1",
    "192.0.0.1",
  ])
    expect(isPublicAddress(address)).toBe(false);
  expect(await limitedPdf(new Response(null))).toHaveLength(0);
});

it.each([
  [{ address: "10.0.0.1", family: 4 }],
  [{ address: "fd00::1", family: 6 }],
  [
    { address: "93.184.216.34", family: 4 },
    { address: "169.254.169.254", family: 4 },
  ],
])(
  "refuses custom API DNS answers containing a private address (%#)",
  async (...answers) => {
    const { defineConfig } = await import("@litscout/core");
    const { apiAgent } = await import("../src/agent-api");
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "litscout-api-dns-"));
    state.dns.mockResolvedValueOnce(answers);
    state.request.mockClear();
    try {
      const config = defineConfig({
        agent: {
          api: {
            provider: "openai",
            keyEnv: "FIXTURE_KEY",
            baseUrl: "https://gateway.example/v1",
            trustedHosts: ["gateway.example"],
            maxRequestsPerDay: 1,
            maxTokensPerDay: 1000,
          },
        },
      }).agent.api!;
      const deps = {
        dir,
        cacheDir: dir,
        fetch: globalThis.fetch,
        env: { FIXTURE_KEY: crypto.randomUUID() },
      } as unknown as import("../src/command-types").SetupDeps;
      await expect(
        apiAgent(deps, config)("{}", 24, { live: true }),
      ).resolves.toMatchObject({
        code: 1,
        diagnostic: expect.stringMatching(/public/i),
      });
      expect(state.request).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
