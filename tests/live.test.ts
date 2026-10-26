import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.ts";

// Live checks against foservices.icegate.gov.in; run with ICEGATE_LIVE=1. 16 requests in total (sequential).
const live = process.env.ICEGATE_LIVE === "1";
const t = { timeout: 60000 };

async function connect() {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer().connect(a);
  const client = new Client({ name: "live", version: "0" });
  await client.connect(b);
  return client;
}
const call = async (c: Client, name: string, args: Record<string, unknown>) => {
  const r: any = await c.callTool({ name, arguments: args });
  return { isError: !!r.isError, text: r.content[0].text as string };
};

describe("live ICEGATE", () => {
  test.skipIf(!live)("location search finds INNSA1", async () => {
    const c = await connect();
    const r = await call(c, "icegate_find_location", { query: "nhava", limit: 50 });
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.text).results.map((l: any) => l.code)).toContain("INNSA1");
    await c.close();
  }, t);

  test.skipIf(!live)("exchange rates include USD; notifications non-empty", async () => {
    const c = await connect();
    const n = await call(c, "icegate_exchange_rate_notifications", { limit: 5 });
    expect(n.isError).toBe(false);
    expect(JSON.parse(n.text).length).toBeGreaterThan(0);
    const r = await call(c, "icegate_exchange_rates", { currencies: ["USD"] });
    expect(r.isError).toBe(false);
    const usd = JSON.parse(r.text).rates.find((x: any) => x.currency === "USD");
    expect(typeof usd.import).toBe("number");
    expect(typeof usd.export).toBe("number");
    await c.close();
  }, t);

  test.skipIf(!live)("warehouse name CONTINENTAL returns rows", async () => {
    const c = await connect();
    const r = await call(c, "icegate_warehouse_code", { name: "CONTINENTAL" });
    expect(r.isError).toBe(false);
    expect(r.text).not.toStartWith("No record found");
    expect(JSON.stringify(JSON.parse(r.text)).toUpperCase()).toContain("CONTINENTAL");
    await c.close();
  }, t);

  test.skipIf(!live)("dummy shipping bill -> no-record text, not an error", async () => {
    const c = await connect();
    const r = await call(c, "icegate_shipping_bill_status", { location: "INNSA1", sbNo: "1234567", sbDate: "2026-10-01" });
    expect(r.isError).toBe(false);
    expect(r.text).toStartWith("No record found");
    await c.close();
  }, t);

  test.skipIf(!live)("codes lookup country DE -> GERMANY", async () => {
    const c = await connect();
    const r = await call(c, "icegate_codes_lookup", { table: "country", code: "DE" });
    expect(r.isError).toBe(false);
    expect(JSON.stringify(JSON.parse(r.text).rows).toUpperCase()).toContain("GERMANY");
    await c.close();
  }, t);

  test.skipIf(!live)("trade guide 0901 with notes -> 09011112 and CHAPTER 9", async () => {
    const c = await connect();
    const r = await call(c, "icegate_trade_guide_exports", { cth: "0901", notes: true });
    expect(r.isError).toBe(false);
    const j = JSON.parse(r.text);
    expect(j.items.map((i: any) => i.code)).toContain("09011112");
    expect(j.section.chapter).toContain("CHAPTER 9");
    await c.close();
  }, t);

  test.skipIf(!live)("import trade guide 8517 has 85171300", async () => {
    const c = await connect();
    const r = await call(c, "icegate_trade_guide_imports", { cth: "8517" });
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.text).items.map((i: any) => i.code)).toContain("85171300");
    await c.close();
  }, t);

  test.skipIf(!live)("import duty 85171300 has bcd head and positive total", async () => {
    const c = await connect();
    const r = await call(c, "icegate_import_duty", { cth: "85171300", assessableValue: 100000 });
    expect(r.isError).toBe(false);
    const j = JSON.parse(r.text);
    expect(j.duties.map((d: any) => d.head)).toContain("bcd");
    expect(j.totalAdValoremPercent.total).toBeGreaterThan(0);
    await c.close();
  }, t);

  test.skipIf(!live)("gstin 27AAACR5055K1Z7 is available", async () => {
    const c = await connect();
    const r = await call(c, "icegate_gstin_status", { gstin: "27AAACR5055K1Z7" });
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.text).available).toBe(true);
    await c.close();
  }, t);
});
