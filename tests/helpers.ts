import { clearLocations } from "../src/client.ts";

export type Call = { url: string; method: string; body: any };
type Reply = { status?: number; body?: unknown; text?: string };

// Replace globalThis.fetch with a stub answering from `handler`; returns the recorded calls and a restore fn.
export function mockFetch(handler: (url: string, call: Call) => Reply | Promise<Reply>) {
  clearLocations();
  const orig = globalThis.fetch;
  const calls: Call[] = [];
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = String(input);
    const call = { url, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const r = await handler(url, call);
    const status = r.status ?? 200;
    return new Response(r.text ?? JSON.stringify(r.body ?? null), { status, statusText: status === 200 ? "OK" : "ERR" });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = orig; } };
}
