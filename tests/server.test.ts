import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BASE } from "../src/client.ts";
import { createServer } from "../src/server.ts";
import { setSend } from "../src/webappl.ts";
import { mockFetch } from "./helpers.ts";

const ENQ = `${BASE}/enquiry/publicEnquiries`;
let m: ReturnType<typeof mockFetch>;
let reply: Parameters<typeof mockFetch>[0];
let client: Client;

beforeEach(async () => {
  reply = () => ({ body: {} });
  m = mockFetch((u, c) => reply(u, c));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer().connect(a);
  client = new Client({ name: "test", version: "0" });
  await client.connect(b);
});
afterEach(async () => { await client.close(); m.restore(); setSend(undefined); });

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r: any = await client.callTool({ name, arguments: args });
  return { isError: !!r.isError, text: r.content[0].text as string };
};

const NOREC = "No record found on ICEGATE";

describe("tools", () => {
  test("lists all 19 tools, read-only", async () => {
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(19);
    expect(new Set(tools.map((t) => t.name)).size).toBe(19);
    for (const t of tools) {
      expect(t.name).toStartWith("icegate_");
      expect(t.annotations?.readOnlyHint).toBe(true);
    }
  });

  test("find_location filters and limits", async () => {
    reply = () => ({ body: { response: [
      { locationCode: "INNSA1", locationName: "NHAVA SHEVA" },
      { locationCode: "INMUN1", locationName: "MUNDRA" },
      { locationCode: "INNSA9", locationName: "NHAVA OTHER" },
    ] } });
    const r = JSON.parse((await call("icegate_find_location", { query: "nhava", limit: 1 })).text);
    expect(r).toEqual({ total: 2, results: [{ code: "INNSA1", name: "NHAVA SHEVA" }] });
  });
});

describe("shipping bill status", () => {
  const args = { location: "innsa1", sbNo: "123", sbDate: "2026-10-01" };

  test("sends correct URL and body", async () => {
    reply = () => ({ body: { sbDetails: [{ a: 1 }] } });
    await call("icegate_shipping_bill_status", args);
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0]!.url).toBe(`${ENQ}/SBTrack_Ices_action_Public`);
    expect(m.calls[0]!.method).toBe("POST");
    expect(m.calls[0]!.body).toEqual({ location: "INNSA1", sbNo: "123", sbDate: "20261001" });
  });

  test("all-empty response -> no record text, not an error", async () => {
    reply = () => ({ body: { sbDetails: [], egm: [], status: null } });
    const r = await call("icegate_shipping_bill_status", args);
    expect(r.isError).toBe(false);
    expect(r.text).toStartWith(NOREC);
  });

  test("null body -> no record text, not an error", async () => {
    reply = () => ({ body: null });
    const r = await call("icegate_shipping_bill_status", args);
    expect(r.isError).toBe(false);
    expect(r.text).toStartWith(NOREC);
  });

  test("keeps non-empty sections, drops empty ones", async () => {
    reply = () => ({ body: { sbDetails: [{ a: 1 }], egm: [], status: "CLEARED", obj: {}, nothing: null } });
    const r = JSON.parse((await call("icegate_shipping_bill_status", args)).text);
    expect(r).toEqual({ sbDetails: [{ a: 1 }], status: "CLEARED", obj: {} });
  });

  test("404 -> no record text", async () => {
    reply = () => ({ status: 404, body: { message: "No Record Found !!" } });
    const r = await call("icegate_shipping_bill_status", args);
    expect([r.isError, r.text.startsWith(NOREC)]).toEqual([false, true]);
  });

  test("login required is surfaced as error", async () => {
    reply = () => ({ status: 400, body: { message: "auth error..!!!" } });
    const r = await call("icegate_shipping_bill_status", args);
    expect(r.isError).toBe(true);
    expect(r.text).toContain("requires login");
  });
});

describe("exchange rates", () => {
  const notifs = [
    { notificationNumber: "10/2026", notPublishDate: "01-03-2026" },
    { notificationNumber: "30/2026", notPublishDate: "15-10-2026" },
    { notificationNumber: "20/2026", notPublishDate: "01-07-2026" },
  ];
  const rates = {
    notificationNumber: "20/2026", notPublishDate: "01-07-2026",
    currencyDetail: [
      { currencyCode: "USD", currencyDesc: "US Dollar", units: "1", cbicImport: 85.5, cbicExport: 83.1 },
      { currencyCode: "JPY", currencyDesc: "Japanese Yen", units: "100", cbicImport: 55, cbicExport: 52 },
      { currencyCode: "EUR", currencyDesc: "Euro", units: "1", cbicImport: 99, cbicExport: 96 },
    ],
  };
  beforeEach(() => { reply = (u) => ({ body: u.endsWith("getnotdetails") ? notifs : rates }); });
  const rateCall = () => m.calls.find((c) => c.url.endsWith("igexratepublishnot"));

  test("picks newest notification published on/before date, filters currencies", async () => {
    const r = JSON.parse((await call("icegate_exchange_rates", { date: "2026-09-30", currencies: ["usd", "JPY"] })).text);
    expect(rateCall()!.body).toEqual({ notNum: "20/2026" });
    expect(r.notification).toBe("20/2026");
    expect(r.rates).toEqual([
      { currency: "USD", name: "US Dollar", units: 1, import: 85.5, export: 83.1 },
      { currency: "JPY", name: "Japanese Yen", units: 100, import: 55, export: 52 },
    ]);
  });

  test("date equal to publish date is included; default picks latest", async () => {
    await call("icegate_exchange_rates", { date: "2026-10-15" });
    expect(rateCall()!.body).toEqual({ notNum: "30/2026" });
    m.calls.length = 0;
    await call("icegate_exchange_rates", {});
    expect(rateCall()!.body).toEqual({ notNum: "30/2026" });
  });

  test("explicit notification skips lookup", async () => {
    await call("icegate_exchange_rates", { notification: "10/2026" });
    expect(m.calls).toHaveLength(1);
    expect(rateCall()!.body).toEqual({ notNum: "10/2026" });
  });

  test("date before all notifications -> error", async () => {
    const r = await call("icegate_exchange_rates", { date: "2020-01-01" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("No exchange-rate notification");
  });

  test("bad notification format rejected", async () => {
    expect((await call("icegate_exchange_rates", { notification: "abc" })).isError).toBe(true);
    expect(m.calls).toHaveLength(0);
  });

  test("notifications list respects limit, newest first", async () => {
    const r = JSON.parse((await call("icegate_exchange_rate_notifications", { limit: 2 })).text);
    expect(r.map((n: any) => n.number)).toEqual(["30/2026", "20/2026"]);
  });
});

describe("warehouse code", () => {
  test("omits unused fields", async () => {
    await call("icegate_warehouse_code", { name: "CONTINENTAL" });
    await call("icegate_warehouse_code", { code: "nsa1u008" });
    await call("icegate_warehouse_code", { code: "x1", name: "N" });
    expect(m.calls.map((c) => c.body)).toEqual([
      { wareHouseName: "CONTINENTAL" },
      { wareHouseCode: "NSA1U008" },
      { wareHouseCode: "X1", wareHouseName: "N" },
    ]);
    expect(m.calls[0]!.url).toBe(`${ENQ}/warehousecode`);
  });
  test("errors with neither", async () => {
    for (const a of [{}, { code: "", name: "" }]) {
      const r = await call("icegate_warehouse_code", a);
      expect(r.isError).toBe(true);
      expect(r.text).toContain("warehouse code or name");
    }
    expect(m.calls).toHaveLength(0);
  });
});

describe("date formats per endpoint", () => {
  test("challan uses dd-MMM-yy", async () => {
    await call("icegate_challan_enquiry", { challanNo: "9", docNo: "77", docDate: "2026-03-07" });
    expect(m.calls[0]!.url).toBe(`${ENQ}/publicChallanBankEnquiry`);
    expect(m.calls[0]!.body).toEqual({ challanNo: "9", docNo: "77", docDate: "07-MAR-26" });
  });
  test("vessel rotation uses dd-MMM-yy", async () => {
    await call("icegate_vessel_rotation", { imoCode: "9321483", fromDate: "2026-09-01", toDate: "2026-10-01" });
    expect(m.calls[0]!.body).toEqual({ imoCode: "9321483", vcnStartDate: "01-SEP-26", vcnEndDate: "01-OCT-26" });
  });
  test("rbi/dgft/gstn use yyyy/MM/dd and uppercase location", async () => {
    await call("icegate_sb_rbi_edpms_status", { location: "innsa1", sbNo: "1", sbDate: "2026-10-01" });
    await call("icegate_sb_dgft_status", { location: "innsa1", sbNo: "1", sbDate: "2026-10-01" });
    await call("icegate_be_gstn_transmission", { portCode: "innsa1", beNo: "1", beDate: "2026-10-01" });
    expect(m.calls.map((c) => c.body)).toEqual([
      { location: "INNSA1", sbNumber: "1", sbDate: "2026/10/01", isLoggedIn: false },
      { location: "INNSA1", sbNo: "1", sbDate: "2026/10/01" },
      { portCode: "INNSA1", beNumber: "1", beDate: "2026/10/01" },
    ]);
  });
});

describe("raw enquiry and validation", () => {
  test("passes method and body through", async () => {
    reply = () => ({ body: { ok: true } });
    const r = await call("icegate_public_enquiry_raw", { method: "postalImport/trackArticle", body: { a: 1 } });
    expect(JSON.parse(r.text)).toEqual({ ok: true });
    expect(m.calls[0]!.url).toBe(`${ENQ}/postalImport/trackArticle`);
  });
  test("rejects path traversal and odd methods", async () => {
    for (const method of ["../x", "a/../b", "..", "a/..", "a b", "x?y=1", "a.b", "", "https://evil"]) {
      const r = await call("icegate_public_enquiry_raw", { method, body: {} });
      expect(r.isError).toBe(true);
    }
    expect(m.calls).toHaveLength(0);
  });
  test("bad dates fail schema validation without fetching", async () => {
    for (const sbDate of ["2026-1-1", "01-10-2026", "20261001", "", "2026-10-01x"]) {
      const r = await call("icegate_shipping_bill_status", { location: "INNSA1", sbNo: "1", sbDate });
      expect(r.isError).toBe(true);
    }
    expect((await call("icegate_exchange_rates", { date: "yesterday" })).isError).toBe(true);
    expect(m.calls).toHaveLength(0);
  });
  test("impossible calendar date returns an error without fetching", async () => {
    const r = await call("icegate_shipping_bill_status", { location: "INNSA1", sbNo: "1", sbDate: "2026-02-30" });
    expect(r.isError).toBe(true);
    expect(m.calls).toHaveLength(0);
  });
  test("missing/short args rejected", async () => {
    expect((await call("icegate_shipping_bill_status", { location: "IN", sbNo: "1", sbDate: "2026-10-01" })).isError).toBe(true);
    expect((await call("icegate_postal_article", {})).isError).toBe(true);
  });
  test("http failure surfaces as error", async () => {
    reply = () => ({ status: 500, body: { message: "boom" } });
    const r = await call("icegate_sez_ports");
    expect(r.isError).toBe(true);
    expect(r.text).toBe("ICEGATE error: boom");
  });
});

describe("webappl tools", () => {
  const tariff = Bun.file(new URL("./fixtures/codes_tariff.html", import.meta.url));
  const sent: { url: string; form?: Record<string, string> }[] = [];
  const mockWeb = (body: (url: string) => string) => {
    sent.length = 0;
    setSend(async (r) => {
      sent.push(r);
      return { status: 200, body: r.method === "GET" && r.url.endsWith("/Codes") ? "" : body(r.url), setCookie: ["JSESSIONID=s1; Path=/"] };
    });
  };

  test("codes_lookup returns {total, rows}", async () => {
    const html = await tariff.text();
    mockWeb(() => html);
    const r = await call("icegate_codes_lookup", { table: "tariff", code: "09", limit: 500 });
    expect(r.isError).toBe(false);
    const j = JSON.parse(r.text);
    expect(j.total).toBe(j.rows.length);
    expect(j.rows[0]).toMatchObject({ CTH: "04109010", "BCD Rate": "30" });
    expect(sent[1]!.form).toMatchObject({ cth: "09" });
    expect(m.calls).toHaveLength(0);
  });
  test("codes_lookup applies limit but reports total", async () => {
    const html = await tariff.text();
    mockWeb(() => html);
    const j = JSON.parse((await call("icegate_codes_lookup", { table: "tariff", code: "0", limit: 3 })).text);
    expect(j.rows).toHaveLength(3);
    expect(j.total).toBeGreaterThan(3);
  });
  test("codes_lookup empty -> no-record text, not an error", async () => {
    const html = await Bun.file(new URL("./fixtures/codes_empty.html", import.meta.url)).text();
    mockWeb(() => html);
    const r = await call("icegate_codes_lookup", { table: "country", code: "ZZ" });
    expect(r.isError).toBe(false);
    expect(r.text).toStartWith(NOREC);
  });
  test("codes_lookup validation errors surface as errors", async () => {
    mockWeb(() => "");
    expect((await call("icegate_codes_lookup", { table: "location", code: "INNSA1" })).isError).toBe(true);
    expect((await call("icegate_codes_lookup", { table: "nope", code: "x" })).isError).toBe(true);
    expect((await call("icegate_codes_lookup", { table: "country" })).isError).toBe(true);
    expect(sent).toHaveLength(0);
  });
  test("trade_guide returns items with total and limit", async () => {
    const items = [1, 2, 3].map((i) => ({ itc_code: `0901111${i}`, itc_desc: ` D${i} `, itchs_policy: "Free", uqc: "KGS", rta: "10" }));
    mockWeb(() => JSON.stringify({ rsAllCth: items }));
    const j = JSON.parse((await call("icegate_trade_guide_exports", { cth: "0901", limit: 2 })).text);
    expect(j.total).toBe(3);
    expect(j.items).toHaveLength(2);
    expect(j.items[0]).toMatchObject({ code: "09011111", description: "D1", exportPolicy: "Free" });
  });
  test("trade_guide rejects non-digit cth via schema", async () => {
    mockWeb(() => "{}");
    for (const cth of ["abc", "9", "123456789", "09 01", "0901x"]) {
      expect((await call("icegate_trade_guide_exports", { cth })).isError).toBe(true);
    }
    expect(sent).toHaveLength(0);
  });
  test("trade_guide empty -> no-record text", async () => {
    mockWeb(() => JSON.stringify({ rsAllCth: [] }));
    const r = await call("icegate_trade_guide_exports", { cth: "9999" });
    expect(r.isError).toBe(false);
    expect(r.text).toStartWith(NOREC);
  });
  test("trade_guide without cth or description is an error", async () => {
    mockWeb(() => "{}");
    expect((await call("icegate_trade_guide_exports", {})).isError).toBe(true);
    expect(sent).toHaveLength(0);
  });

  const fx = (n: string) => Bun.file(new URL(`./fixtures/${n}`, import.meta.url)).text();

  test("trade_guide_imports uses import endpoint and importPolicy", async () => {
    mockWeb(() => JSON.stringify({ rsAllCth: [{ itc_code: "85171300", itc_desc: " Smartphones ", itchs_policy: "Free", uqc: "NOS", rta: "20" }] }));
    const j = JSON.parse((await call("icegate_trade_guide_imports", { cth: "8517" })).text);
    expect(j.total).toBe(1);
    expect(j.items[0]).toMatchObject({ code: "85171300", importPolicy: "Free" });
    expect(sent[0]!.url).toContain("/Desc_details?");
    expect((await call("icegate_trade_guide_imports", { cth: "abc" })).isError).toBe(true);
  });
  test("trade_guide_imports empty -> no-record text", async () => {
    mockWeb(() => JSON.stringify({ rsAllCth: [] }));
    const r = await call("icegate_trade_guide_imports", { cth: "9999" });
    expect(r.isError).toBe(false);
    expect(r.text).toStartWith(NOREC);
  });
  test("gstin_status returns parsed result", async () => {
    const html = await fx("gstin_active.html");
    mockWeb(() => html);
    const j = JSON.parse((await call("icegate_gstin_status", { gstin: "27aaacr5055k1z7" })).text);
    expect(j).toMatchObject({ gstin: "27AAACR5055K1Z7", available: true, legalName: "RELIANCE INDUSTRIES LIMITED", lastUpdateFromGstn: "16/10/2026" });
    expect(sent[1]!.form).toMatchObject({ gstn_no: "27AAACR5055K1Z7" });
  });
  test("gstin_status unavailable is not an error", async () => {
    const html = await fx("gstin_unavailable.html");
    mockWeb(() => html);
    const r = await call("icegate_gstin_status", { gstin: "29AAACI4798L1ZT" });
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.text).available).toBe(false);
  });
  test("gstin_status rejects malformed GSTIN", async () => {
    mockWeb(() => "");
    for (const gstin of ["", "27AAACR5055K1Z", "27AAACR5055K1Z7X", "27AAACR5055K1Z-"]) {
      expect((await call("icegate_gstin_status", { gstin })).isError).toBe(true);
    }
    expect(sent).toHaveLength(0);
  });
  test("import_duty returns totals and amounts", async () => {
    const files: Record<string, string> = {
      DueFee1: await fx("duty_DueFee1_85171300.json"),
      DueFee111: await fx("duty_DueFee111_85171300.json"),
      CDC_Desc: await fx("duty_CDC_Desc_85171300.json"),
    };
    mockWeb((url) => files[new URL(url).pathname.split("/").pop()!] ?? "");
    const j = JSON.parse((await call("icegate_import_duty", { cth: "85171300", assessableValue: 100000 })).text);
    expect(j.totalAdValoremPercent.total).toBeCloseTo(49.152, 6);
    expect(j.dutyOnAssessableValue.total).toBe(49152);
  });
  test("import_duty empty bodies -> no-record text; bad CTH rejected", async () => {
    mockWeb(() => "");
    const r = await call("icegate_import_duty", { cth: "11111111" });
    expect(r.isError).toBe(false);
    expect(r.text).toStartWith(NOREC);
    sent.length = 0;
    for (const cth of ["8517", "8517130a", "851713000"]) expect((await call("icegate_import_duty", { cth })).isError).toBe(true);
    expect(sent).toHaveLength(0);
  });
});
