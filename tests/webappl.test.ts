import { afterEach, describe, expect, test } from "bun:test";
import { IcegateError } from "../src/client.ts";
import { WEBAPPL, codesLookup, dutyPercent, gstinLookup, importDuty, parseCodesTable, parseGstin, setSend, tradeGuide, type Req, type Res } from "../src/webappl.ts";

const fixture = (n: string) => Bun.file(new URL(`./fixtures/${n}`, import.meta.url)).text();

let calls: Req[] = [];
function mockSend(handler: (r: Req) => Partial<Res> | Promise<Partial<Res>>) {
  calls = [];
  setSend(async (r) => {
    calls.push(r);
    const x = await handler(r);
    return { status: 200, body: "", setCookie: [], ...x };
  });
}
afterEach(() => setSend(undefined));

describe("parseCodesTable", () => {
  test("tariff: many rows packed in one <tr> are re-chunked by header width", async () => {
    const rows = parseCodesTable(await fixture("codes_tariff.html"));
    expect(rows.length).toBeGreaterThan(10);
    expect(rows[0]).toMatchObject({ CTH: "04109010", "BCD Rate": "30" });
    expect(Object.keys(rows[0]!)).toHaveLength(5);
    expect(rows.find((r) => r.CTH === "09011112")?.["BCD Rate"]).toBe("100");
  });
  test("location: single row", async () => {
    const rows = parseCodesTable(await fixture("codes_location.html"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ "Location Code": "INNSA1", Category: "SEA" });
  });
  test("currency: two rows", async () => {
    const rows = parseCodesTable(await fixture("codes_currency.html"));
    expect(rows.map((r) => r["Currency Code"])).toEqual(["EU", "EUR"]);
  });
  test("header but no rows -> []", async () => {
    expect(parseCodesTable(await fixture("codes_empty.html"))).toEqual([]);
  });
  test("garbage html -> []", () => {
    expect(parseCodesTable("<html>nothing</html>")).toEqual([]);
  });
});

describe("codesLookup", () => {
  test("GET /Codes then POST with uppercased fields, cookie, referer", async () => {
    const page = await fixture("codes_currency.html");
    mockSend((r) => r.method === "GET"
      ? { setCookie: ["JSESSIONID=abc123; Path=/Webappl; Secure; HttpOnly"] }
      : { body: page });
    const rows = await codesLookup("currency", { code: " eur ", name: "euro" });
    expect(rows).toHaveLength(2);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ method: "GET", url: `${WEBAPPL}/Codes` });
    const p = calls[1]!;
    expect(p.method).toBe("POST");
    expect(p.url).toBe(`${WEBAPPL}/CUR_DET`);
    expect(p.form).toEqual({ submitbutton: "Search", ccode: "EUR", item: "EURO" });
    expect(p.cookie).toBe("JSESSIONID=abc123");
    expect(p.referer).toBe(`${WEBAPPL}/CUR_ENQ`);
  });
  test("code-only search sends empty name field", async () => {
    mockSend((r) => (r.method === "GET" ? { setCookie: ["JSESSIONID=x; Path=/"] } : { body: "" }));
    expect(await codesLookup("country", { code: "de" })).toEqual([]);
    expect(calls[1]!.form).toEqual({ submitbutton: "Search", ccode: "DE", item: "" });
  });
  test("tariff action differs from page and uses cth", async () => {
    mockSend((r) => (r.method === "GET" ? { setCookie: ["JSESSIONID=x"] } : { body: "" }));
    await codesLookup("tariff", { code: "0901" });
    expect(calls[1]!.form).toEqual({ submitbutton: "Search", cth: "0901" });
    expect(calls[1]!.referer).toBe(`${WEBAPPL}/CTH_ENQ`);
  });
  test("validation errors make no requests", async () => {
    mockSend(() => ({}));
    const bad = async (t: Parameters<typeof codesLookup>[0], q: { code?: string; name?: string }) => {
      const e: any = await codesLookup(t, q).catch((x) => x);
      expect(e).toBeInstanceOf(IcegateError);
      expect(e.kind).toBe("invalid");
    };
    await bad("country", {});
    await bad("country", { code: "  ", name: "" });
    await bad("location", { code: "INNSA1" });
    await bad("tariff", { name: "coffee" });
    expect(calls).toHaveLength(0);
  });
  test("non-200 -> IcegateError http", async () => {
    mockSend(() => ({ status: 503 }));
    const e: any = await codesLookup("country", { code: "DE" }).catch((x) => x);
    expect(e).toBeInstanceOf(IcegateError);
    expect(e.kind).toBe("http");
    expect(e.status).toBe(503);
    expect(calls).toHaveLength(1);
  });
  test("non-200 on POST -> http error", async () => {
    mockSend((r) => (r.method === "GET" ? { setCookie: ["JSESSIONID=x"] } : { status: 500 }));
    const e: any = await codesLookup("country", { code: "DE" }).catch((x) => x);
    expect(e.kind).toBe("http");
  });
});

describe("tradeGuide", () => {
  const item = { itc_code: "09011112", itc_desc: "  COFFEE, NOT ROASTED  ", itchs_policy: "Free", uqc: "KGS", rta: "10" };
  const notes = {
    rs_sec_chaptr: [{ section: "II", sec_details: "VEGETABLE PRODUCTS", chapter: "CHAPTER 9", chap_details: "COFFEE, TEA" }],
    rs_sec_chaptr1: [{ main_notes: "note A" }, { main_notes: "note B" }],
    rs_sec_chaptr2: [{ subhead_notes: "cond 1" }],
    rs_sec_chaptr3: ["x"],
    rs_sec_chaptr4: ["y"],
  };

  test("maps items; query has cth and uppercased item_desc", async () => {
    mockSend(() => ({ body: JSON.stringify({ rsAllCth: [item] }) }));
    const r = await tradeGuide({ cth: "0901", description: "coffee" });
    expect(r).toEqual({ items: [{ code: "09011112", description: "COFFEE, NOT ROASTED", exportPolicy: "Free", unit: "KGS", tariffRate: "10" }] });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("GET");
    const u = new URL(calls[0]!.url);
    expect(u.pathname.endsWith("/Desc_details_itchs")).toBe(true);
    expect(u.searchParams.get("cth")).toBe("0901");
    expect(u.searchParams.get("item_desc")).toBe("COFFEE");
  });
  test("description only leaves cth empty", async () => {
    mockSend(() => ({ body: JSON.stringify({ rsAllCth: [] }) }));
    await tradeGuide({ description: "tea" });
    const u = new URL(calls[0]!.url);
    expect(u.searchParams.get("cth")).toBe("");
    expect(u.searchParams.get("item_desc")).toBe("TEA");
  });
  test("notes=true fetches notes endpoint and maps fields", async () => {
    mockSend((r) => ({ body: JSON.stringify(r.url.includes("DescdetailsNotesItchs") ? notes : { rsAllCth: [item] }) }));
    const r: any = await tradeGuide({ cth: "0901", notes: true });
    expect(calls).toHaveLength(2);
    expect(new URL(calls[1]!.url).pathname.endsWith("/DescdetailsNotesItchs")).toBe(true);
    expect(new URL(calls[1]!.url).searchParams.get("cth")).toBe("0901");
    expect(r.items).toHaveLength(1);
    expect(r.section).toEqual({ section: "II", sectionTitle: "VEGETABLE PRODUCTS", chapter: "CHAPTER 9", chapterTitle: "COFFEE, TEA" });
    expect(r.chapterNotes).toEqual(["note A", "note B"]);
    expect(r.policyConditions).toEqual(["cond 1"]);
    expect(r.otherNotes).toEqual(["x", "y"]);
  });
  test("notes skipped without cth", async () => {
    mockSend(() => ({ body: JSON.stringify({ rsAllCth: [item] }) }));
    const r: any = await tradeGuide({ description: "coffee", notes: true });
    expect(calls).toHaveLength(1);
    expect(r.section).toBeUndefined();
    expect(r.chapterNotes).toBeUndefined();
  });
  test("empty body -> no items", async () => {
    mockSend(() => ({ body: "  \n" }));
    expect(await tradeGuide({ cth: "9999" })).toEqual({ items: [] });
  });
  test("non-JSON body -> error", async () => {
    mockSend(() => ({ body: "<html>oops</html>" }));
    const e: any = await tradeGuide({ cth: "0901" }).catch((x) => x);
    expect(e).toBeInstanceOf(IcegateError);
    expect(e.message).toContain("non-JSON");
  });
  test("non-200 -> http error; no query -> invalid", async () => {
    mockSend(() => ({ status: 500 }));
    expect(((await tradeGuide({ cth: "0901" }).catch((x) => x)) as any).kind).toBe("http");
    expect(((await tradeGuide({}).catch((x) => x)) as any).kind).toBe("invalid");
  });
});

describe("tradeGuide (imports)", () => {
  const item = { itc_code: "85171300", itc_desc: " Smartphones ", itchs_policy: "Free", uqc: "NOS", rta: "20" };
  const notes = {
    rs_sec_chaptr: [{ section: "XVI", sec_details: "MACHINERY", chapter: "CHAPTER 85", chap_details: "ELECTRICAL" }],
    rs_sec_chaptr1: [{ main_notes: "chap note" }],
    rs_sec_chaptr2: [{ subhead_notes: "sub note" }],
    rs_sec_chaptr3: [{ suppl_notes: "supp" }],
    rs_sec_chaptr4: [{ oth_notes: "oth" }],
  };
  test("uses import endpoints and importPolicy", async () => {
    mockSend(() => ({ body: JSON.stringify({ rsAllCth: [item] }) }));
    const r = await tradeGuide({ cth: "8517", kind: "import" });
    expect(r).toEqual({ items: [{ code: "85171300", description: "Smartphones", importPolicy: "Free", unit: "NOS", tariffRate: "20" }] });
    expect(new URL(calls[0]!.url).pathname.endsWith("/Desc_details")).toBe(true);
  });
  test("notes: Desc_details_Notes, subheadingNotes, no policyConditions", async () => {
    mockSend((r) => ({ body: JSON.stringify(r.url.includes("Desc_details_Notes") ? notes : { rsAllCth: [item] }) }));
    const r: any = await tradeGuide({ cth: "8517", notes: true, kind: "import" });
    expect(new URL(calls[1]!.url).pathname.endsWith("/Desc_details_Notes")).toBe(true);
    expect(r.subheadingNotes).toEqual(["sub note"]);
    expect(r.policyConditions).toBeUndefined();
    expect(r.chapterNotes).toEqual(["chap note"]);
    expect(r.otherNotes).toEqual(["supp", "oth"]);
    expect(r.section.chapter).toBe("CHAPTER 85");
  });
});

describe("parseGstin / gstinLookup", () => {
  test("active", async () => {
    expect(parseGstin(await fixture("gstin_active.html"))).toEqual({
      gstin: "27AAACR5055K1Z7", available: true, legalName: "RELIANCE INDUSTRIES LIMITED", lastUpdateFromGstn: "16/10/2026", message: undefined,
    });
  });
  test("unavailable", async () => {
    const r = parseGstin(await fixture("gstin_unavailable.html"))!;
    expect(r.gstin).toBe("29AAACI4798L1ZT");
    expect(r.available).toBe(false);
    expect(r.legalName).toBeUndefined();
    expect(r.lastUpdateFromGstn).toBeUndefined();
    expect(r.message).toContain("is not available with Customs");
    expect(r.message).toContain("helpdesk");
  });
  test("no match -> undefined", () => {
    expect(parseGstin("<html>nothing</html>")).toBeUndefined();
  });
  test("lookup: GET /GSTN then POST with normalised gstn_no, cookie, referer", async () => {
    const page = await fixture("gstin_active.html");
    mockSend((r) => (r.method === "GET" ? { setCookie: ["JSESSIONID=g1; Path=/"] } : { body: page }));
    const r = await gstinLookup(" 27aaacr5055k1z7-");
    expect(r.available).toBe(true);
    expect(calls[0]).toMatchObject({ method: "GET", url: `${WEBAPPL}/GSTN` });
    expect(calls[1]).toMatchObject({ method: "POST", url: `${WEBAPPL}/GSTN-Number-Enquiry`, cookie: "JSESSIONID=g1", referer: `${WEBAPPL}/GSTN` });
    expect(calls[1]!.form).toEqual({ gstn_no: "27AAACR5055K1Z7", submitbutton: "Search" });
  });
  test("unparseable page -> not_found; non-200 -> http", async () => {
    mockSend((r) => (r.method === "GET" ? { setCookie: ["JSESSIONID=x"] } : { body: "<html></html>" }));
    expect(((await gstinLookup("27AAACR5055K1Z7").catch((x) => x)) as any).kind).toBe("not_found");
    mockSend(() => ({ status: 502 }));
    expect(((await gstinLookup("27AAACR5055K1Z7").catch((x) => x)) as any).kind).toBe("http");
  });
});

describe("dutyPercent", () => {
  const zero = { bcd: 0, aidc: 0, eaidc: 0, adc: 0, ncd: 0, cess: 0, chess: 0, hlth: 0, and: 0, cntv: 0, safg: 0, scd: 0, igst: 0, gstcess: 0 };
  test("simple BCD + SWS + IGST", () => {
    const r = dutyPercent({ ...zero, bcd: 20, aidc: 20, scd: 10, igst: 18 });
    expect(r.customsDuty).toBeCloseTo(26.4, 6);
    expect(r.igst).toBeCloseTo(22.752, 6);
    expect(r.total).toBeCloseTo(49.152, 6);
  });
  test("bcd 0 zeroes AIDC and SWS", () => {
    const r = dutyPercent({ ...zero, bcd: 0, aidc: 50, scd: 10, igst: 18 });
    expect(r.byHead.aidc).toBe(0);
    expect(r.byHead.scd).toBe(0);
    expect(r.customsDuty).toBe(0);
    expect(r.igst).toBeCloseTo(18, 6);
  });
  test("CTH 7106/7108 excludes AIDC from SWS base", () => {
    const rates = { ...zero, bcd: 10, aidc: 100, scd: 10 };
    expect(dutyPercent(rates, "71081200").byHead.scd).toBeCloseTo(1, 6);
    expect(dutyPercent(rates, "71061000").byHead.scd).toBeCloseTo(1, 6);
    expect(dutyPercent(rates, "71091000").byHead.scd).toBeCloseTo(2, 6);
    expect(dutyPercent(rates).byHead.scd).toBeCloseTo(2, 6);
  });
});

describe("importDuty", () => {
  const dutyRoutes = (cth: string, extra: Record<string, unknown> = {}) => async (r: Req) => {
    const name = new URL(r.url).pathname.split("/").pop()!;
    const f = `duty_${name}_${cth}.json`;
    const exists = await Bun.file(new URL(`./fixtures/${f}`, import.meta.url)).exists();
    return { body: name in extra ? JSON.stringify(extra[name]) : exists ? await fixture(f) : "" };
  };

  test("85171300: totals, governing notification, 3 GETs, no DueFee11", async () => {
    mockSend(dutyRoutes("85171300"));
    const r: any = await importDuty({ cth: "85171300", assessableValue: 100000 });
    expect(calls).toHaveLength(3);
    const paths = calls.map((c) => new URL(c.url).pathname.split("/").pop()).sort();
    expect(paths).toEqual(["CDC_Desc", "DueFee1", "DueFee111"]);
    for (const c of calls) {
      const u = new URL(c.url);
      expect(u.searchParams.get("cth_val")).toBe("85171300");
      expect(u.searchParams.get("cntrycd")).toBe("");
    }
    expect(r.totalAdValoremPercent.customsDuty).toBeCloseTo(26.4, 6);
    expect(r.totalAdValoremPercent.igst).toBeCloseTo(22.752, 6);
    expect(r.totalAdValoremPercent.total).toBeCloseTo(49.152, 6);
    expect(r.dutyOnAssessableValue.total).toBe(49152);
    const igst = r.duties.find((d: any) => d.head === "igst");
    expect(igst.notification).toEqual({ notn: "045/2025", slno: "I229" });
    expect(igst.effectiveRate).toBe(18);
    expect(r.duties.find((d: any) => d.head === "bcd").effectiveRate).toBe(20);
    expect(r.duties.find((d: any) => d.head === "bcd").exemptionNotifications).toBeUndefined();
    expect(r.description).toBe("Smartphones");
    expect(r.hierarchy).toHaveLength(2);
    expect(r.policyNotes.length).toBeGreaterThan(0);
    expect(r.caveats.some((c: string) => /Country of origin/.test(c))).toBe(false);
  });
  test("exemptions=true adds DueFee11, capped at 50 with count", async () => {
    mockSend(dutyRoutes("85171300"));
    const r: any = await importDuty({ cth: "85171300", exemptions: true });
    expect(calls).toHaveLength(4);
    expect(calls.some((c) => new URL(c.url).pathname.endsWith("/DueFee11"))).toBe(true);
    const bcd = r.duties.find((d: any) => d.head === "bcd");
    expect(bcd.exemptionCount).toBe(290);
    expect(bcd.exemptionNotifications).toHaveLength(50);
    expect(bcd.exemptionNotifications[0]).toMatchObject({ notn: "001/2022", slno: "1", rate: 0 });
    expect(r.dutyOnAssessableValue).toBeUndefined();
  });
  test("09011112: total 236, cess specific duty on cess head", async () => {
    mockSend(dutyRoutes("09011112"));
    const r: any = await importDuty({ cth: "09011112" });
    expect(r.totalAdValoremPercent.total).toBeCloseTo(236, 6);
    const cess = r.duties.find((d: any) => d.head === "cess");
    expect(cess.specificDuty).toBe(25);
    expect(cess.unit).toBe("QTL");
    expect(r.agencies).toHaveLength(2);
  });
  test("87032291: NCCD + cess, total 226.20525", async () => {
    mockSend(dutyRoutes("87032291", { CDC_Desc: { rs_itchs_new: [{ itc_code: "87032291", itc_desc: "Car" }] } }));
    const r: any = await importDuty({ cth: "87032291" });
    expect(r.totalAdValoremPercent.total).toBeCloseTo(226.20525, 6);
    expect(r.duties.find((d: any) => d.head === "ncd").effectiveRate).toBe(1);
  });
  test("country sent uppercased and caveat added", async () => {
    mockSend(dutyRoutes("85171300"));
    const r: any = await importDuty({ cth: "85171300", country: "jp,japan" });
    expect(new URL(calls[0]!.url).searchParams.get("cntrycd")).toBe("JP,JAPAN");
    expect(r.caveats.some((c: string) => /Country of origin/.test(c))).toBe(true);
  });
  test("empty DueFee bodies -> not_found", async () => {
    mockSend(() => ({ body: "" }));
    const e: any = await importDuty({ cth: "11111111" }).catch((x) => x);
    expect(e).toBeInstanceOf(IcegateError);
    expect(e.kind).toBe("not_found");
  });
  test("non-8-digit CTH rejected without requests", async () => {
    mockSend(() => ({}));
    for (const cth of ["8517", "851713001", "8517130x", ""]) {
      expect(((await importDuty({ cth }).catch((x) => x)) as any).kind).toBe("invalid");
    }
    expect(calls).toHaveLength(0);
  });
});
