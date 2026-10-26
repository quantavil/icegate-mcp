// Client for the legacy www.icegate.gov.in/Webappl pages that need no captcha:
// CODES (Customs Online Directory Enquiry System) and the Trade Guide on Exports.
import https from "node:https";
import { rootCertificates } from "node:tls";
import { ENTRUST_DV_INTERMEDIATE } from "./ca.ts";
import { IcegateError } from "./client.ts";

export const WEBAPPL = process.env.ICEGATE_WEBAPPL_URL ?? "https://www.icegate.gov.in/Webappl";
const TIMEOUT_MS = Number(process.env.ICEGATE_TIMEOUT_MS ?? 30000);
const CA = [...rootCertificates, ENTRUST_DV_INTERMEDIATE];

export type Req = { method: "GET" | "POST"; url: string; form?: Record<string, string>; cookie?: string; referer?: string };
export type Res = { status: number; body: string; setCookie: string[] };

// node:https rather than fetch so the extra CA works under both Bun and Node (the .mcpb bundle).
function httpsSend(r: Req): Promise<Res> {
  const body = r.form ? new URLSearchParams(r.form).toString() : undefined;
  return new Promise((resolve, reject) => {
    const req = https.request(r.url, {
      method: r.method,
      ca: CA,
      timeout: TIMEOUT_MS,
      headers: {
        "User-Agent": "Mozilla/5.0 (icegate-mcp/0.1)",
        ...(r.cookie && { Cookie: r.cookie }),
        ...(r.referer && { Referer: r.referer }),
        ...(body && { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": String(Buffer.byteLength(body)) }),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({
        status: res.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("latin1").replace(/\0/g, ""),
        setCookie: res.headers["set-cookie"] ?? [],
      }));
    });
    req.on("timeout", () => req.destroy(new Error(`timeout after ${TIMEOUT_MS} ms`)));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

let send = httpsSend;
export const setSend = (fn: typeof httpsSend | undefined) => { send = fn ?? httpsSend; };

async function ok(r: Req) {
  const res = await send(r);
  if (res.status !== 200) throw new IcegateError(`ICEGATE Webappl HTTP ${res.status}`, res.status, "http");
  return res;
}

// --- CODES directory ---------------------------------------------------------
// Each lookup is an HTML form that POSTs code/name fields; the server needs a JSESSIONID from the Codes page first.
export const CODES = {
  tariff: { page: "CTH_ENQ", action: "CTH_ENQ", code: "cth", label: "Customs tariff head (CTH) with BCD / specific duty; code matches anywhere in the CTH" },
  itchs: { page: "ITCHS_ENQ1", action: "ITCHS_ENQ1", code: "cth", name: "item", label: "ITC(HS) code" },
  location: { page: "LOCATION_ENQ", action: "LOCATION_ENQ", name: "item", label: "Customs location code (with category and EDI date)" },
  currency: { page: "CUR_ENQ", action: "CUR_DET", code: "ccode", name: "item", label: "Currency code" },
  country: { page: "COUNTRY_ENQ", action: "COUNTRY_CODE", code: "ccode", name: "item", label: "Country code" },
  state: { page: "STATE_ENQ", action: "STATE_DET", code: "scode", name: "item", label: "Indian state code" },
  uqc: { page: "UQC_ENQ", action: "UQC_ENQ", code: "cth", name: "item", label: "Unit quantity code (UQC)" },
  package: { page: "PKGCD_ENQ", action: "PKGCD_ENQ", code: "cth", name: "item", label: "Package code" },
  sea_port: { page: "PORTSEACODE_ENQ", action: "PORTSEACODE_DET", code: "pcode", name: "item", label: "Sea port code (world)" },
  air_port: { page: "PORTAIRCODE_ENQ", action: "PORTAIRCODE_DET", code: "pcode", name: "item", label: "Air port code (world)" },
  airline: { page: "AIRLINE_ENQ", action: "AIRLINE_DET", code: "acode", name: "item", label: "Airline code" },
  shipping_line: { page: "SHIPPINGLINE_ENQ", action: "SHIPPINGLINE_DET", code: "scode", name: "item", label: "Shipping line code" },
  supporting_doc: { page: "SUPP_ENQ", action: "SUPP_DOC", code: "scode", name: "item", label: "Supporting document (e-Sanchit) code" },
} as const satisfies Record<string, { page: string; action: string; code?: string; name?: string; label: string }>;
export type CodeTable = keyof typeof CODES;

const decode = (s: string) => s
  .replace(/<[^>]+>/g, "")
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
  .replace(/\s+/g, " ").trim();

// Result pages are: banner row, title row, "<query> LIKE x" row, header row, data rows, footer rows.
// Some pages pack every data cell into one <tr>, so cells are flattened and re-chunked by header width.
export function parseCodesTable(html: string): Record<string, string>[] {
  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map((m) => [...m[1]!.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => decode(c[1]!)))
    .filter((cells) => cells.some(Boolean));
  const qi = rows.findIndex((r) => r.length === 1 && /like|:|=/i.test(r[0]!));
  if (qi < 0 || !rows[qi + 1]) return [];
  const header = rows[qi + 1]!;
  const cells = rows.slice(qi + 2).filter((r) => !r.some((c) => /Filename to Save As/i.test(c)) && !(r.length === 1 && r[0] === "null")).flat();
  const out: Record<string, string>[] = [];
  for (let i = 0; i + header.length <= cells.length; i += header.length)
    out.push(Object.fromEntries(header.map((h, j) => [h, cells[i + j]!])));
  return out;
}

export async function codesLookup(table: CodeTable, q: { code?: string; name?: string }) {
  const t: { page: string; action: string; code?: string; name?: string } = CODES[table];
  const code = q.code?.toUpperCase().trim(), name = q.name?.toUpperCase().trim();
  if (!code && !name) throw new IcegateError("Provide a code or a name to search.", 0, "invalid");
  if (code && !t.code) throw new IcegateError(`The ${table} table can only be searched by name.`, 0, "invalid");
  if (name && !t.name) throw new IcegateError(`The ${table} table can only be searched by code.`, 0, "invalid");
  const start = await ok({ method: "GET", url: `${WEBAPPL}/Codes` });
  const cookie = start.setCookie.map((c) => c.split(";")[0]).join("; ");
  const form: Record<string, string> = { submitbutton: "Search" };
  if (t.code) form[t.code] = code ?? "";
  if (t.name) form[t.name] = name ?? "";
  const res = await ok({ method: "POST", url: `${WEBAPPL}/${t.action}`, form, cookie, referer: `${WEBAPPL}/${t.page}` });
  return parseCodesTable(res.body);
}

// --- Know your Import Duty (cdc_duty_details.jsp) ----------------------------
// The duty page fills itself from four GETs: DueFee1 = tariff rates, DueFee111 = effective rates (+ governing
// notification), DueFee11 = candidate exemption notifications per head, CDC_Desc = description and policy.
// Country of origin is accepted by the server but changed nothing in testing (no FTA/preferential rates returned).
const HEADS = [
  { key: "bcd", name: "Basic Customs Duty (BCD)", group: "rs_bcdd" },
  { key: "aidc", name: "Agriculture Infrastructure & Development Cess (AIDC, % of BCD)", group: "rs_aidcnotn" },
  { key: "eaidc", name: "Extra AIDC", group: "rs_eaidcnotn" },
  { key: "adc", name: "Additional Duty of Customs / CVD (ADC)", group: "rs_adcnotn" },
  { key: "ncd", name: "National Calamity Contingent Duty (NCCD)" },
  { key: "cess", name: "Customs cess", group: "rs_ex_ecessnotn" },
  { key: "chess", name: "CH cess", group: "rs_chcessdd" },
  { key: "hlth", name: "Health cess" },
  { key: "and", name: "Anti-dumping duty" },
  { key: "cntv", name: "Countervailing duty" },
  { key: "safg", name: "Safeguard duty" },
  { key: "scd", name: "Social Welfare Surcharge (SWS, % of duty subtotal)", group: "rs_sws" },
  { key: "igst", name: "IGST", group: "rs_igstdd" },
  { key: "gstcess", name: "GST compensation cess", group: "rs_igstddcess" },
] as const;
type HeadKey = (typeof HEADS)[number]["key"];

const num = (v: unknown) => (typeof v === "number" ? v : Number(v) || 0);
const pick = (o: any, h: string, ...suffixes: string[]) => suffixes.map((s) => o?.[`${h}${s}`]).find((v) => v !== undefined && v !== "");
const rateOf = (o: any, h: string) => num(pick(o, h, "_rate", "_rta", "rta"));

// Ad-valorem duty as % of assessable value, following the page's gettotalEffectiveOnload.
export function dutyPercent(r: Record<HeadKey, number>, cth = "") {
  const B = r.bcd, z = B === 0;
  const AID = z ? 0 : (B * r.aidc) / 100;
  const ADC = ((100 + B) * r.adc) / 100;
  const NCD = z ? 0 : ((100 + B + ADC) * r.ncd) / 100;
  const EAI = z ? 0 : ((100 + B + NCD + ADC) * r.eaidc) / 100;
  const CES = ((100 + B) * r.cess) / 100;
  const HLT = ((100 + B + NCD) * r.hlth) / 100;
  const base = 100 + B + ADC + NCD;
  const AND = (base * r.and) / 100, CNV = (base * r.cntv) / 100, SFG = (base * r.safg) / 100;
  const CHC = r.chess;
  const swsAidc = /^710[68]/.test(cth) ? 0 : AID;
  const SWS = z ? 0 : ((B + EAI + swsAidc + ADC + NCD + CES + CHC) * r.scd) / 100;
  const M = B + AID + EAI + ADC + CES + SWS + NCD + HLT + AND + CNV + SFG + CHC;
  const IGST = ((100 + M) * r.igst) / 100, GCESS = ((100 + M) * r.gstcess) / 100;
  const round = (x: number) => Math.round(x * 1e6) / 1e6;
  return {
    byHead: Object.fromEntries(Object.entries({ bcd: B, aidc: AID, eaidc: EAI, adc: ADC, ncd: NCD, cess: CES, chess: CHC, hlth: HLT, and: AND, cntv: CNV, safg: SFG, scd: SWS, igst: IGST, gstcess: GCESS }).map(([k, v]) => [k, round(v)])) as Record<HeadKey, number>,
    customsDuty: round(M), igst: round(IGST), gstCess: round(GCESS), total: round(M + IGST + GCESS),
  };
}

export async function importDuty(q: { cth: string; country?: string; assessableValue?: number; exemptions?: boolean }) {
  if (!/^\d{8}$/.test(q.cth)) throw new IcegateError("CTH must be an 8-digit tariff item.", 0, "invalid");
  const p = new URLSearchParams({ cth_val: q.cth, cntrycd: q.country?.toUpperCase() ?? "" }).toString();
  const [tariff, eff, desc, notns] = await Promise.all([
    json(`DueFee1?${p}`), json(`DueFee111?${p}`), json(`CDC_Desc?${p}`), q.exemptions ? json(`DueFee11?${p}`) : Promise.resolve({}),
  ]);
  if (Object.keys(eff).length === 0 && Object.keys(tariff).length === 0) throw new IcegateError("No record found.", 200, "not_found");
  const rates = Object.fromEntries(HEADS.map((h) => [h.key, rateOf(eff, h.key)])) as Record<HeadKey, number>;
  const calc = dutyPercent(rates, q.cth);
  const duties = HEADS.map((h) => {
    const notn = pick(eff, h.key, "_notn"), group = "group" in h ? (notns as any)[h.group] : undefined;
    return {
      head: h.key, name: h.name,
      tariffRate: rateOf(tariff, h.key), effectiveRate: rates[h.key],
      specificDuty: num(pick(eff, h.key, "_spc_amts", "_amts", "amts")) || num(pick(tariff, h.key, "_spc_amts", "_amts", "amts")) || undefined,
      unit: pick(eff, h.key, "_uqc", "uqc") ?? pick(tariff, h.key, "_uqc", "uqc"),
      notification: notn ? { notn, slno: pick(eff, h.key, "_slno") } : undefined,
      percentOfValue: calc.byHead[h.key],
      ...(Array.isArray(group) && group.length > 0 && {
        exemptionNotifications: group.slice(0, 50).map((n: any) => ({ notn: n.notn, slno: n.slno, rate: n.rta, cond: n.cond ?? n["nvl(cond,'y')"] })),
        exemptionCount: group.length,
      }),
    };
  }).filter((d) => d.tariffRate || d.effectiveRate || d.specificDuty || d.notification || d.exemptionCount);
  const hier = (desc.rs_itchs_new ?? []).map((i: any) => ({ code: i.itc_code, description: i.itc_desc?.trim() }));
  const ccr: string | undefined = desc.rs_rmsccr_new?.[0]?.ccr_apr;
  const av = q.assessableValue;
  return {
    cth: q.cth,
    description: hier.at(-1)?.description,
    hierarchy: hier,
    importPolicy: desc.rs_itchspolicy_new ?? [],
    policyNotes: ccr?.split(/\*+/).map((s) => s.trim()).filter(Boolean),
    agencies: desc.rs_pgaheading_new,
    duties,
    totalAdValoremPercent: { customsDuty: calc.customsDuty, igst: calc.igst, gstCess: calc.gstCess, total: calc.total },
    ...(av !== undefined && {
      dutyOnAssessableValue: { assessableValue: av, customsDuty: Math.round((av * calc.customsDuty) / 100), igst: Math.round((av * calc.igst) / 100), gstCess: Math.round((av * calc.gstCess) / 100), total: Math.round((av * calc.total) / 100) },
    }),
    caveats: [
      "Indicative only, from ICEGATE's Know-your-Import-Duty data; the Bill of Entry assessment is authoritative.",
      "Specific duties (per unit) are listed per head but not included in the ad-valorem totals.",
      ...(q.country ? ["Country of origin was sent, but ICEGATE returned no preferential/FTA rates; rates shown are MFN."] : []),
    ],
  };
}

// --- GSTIN enquiry -----------------------------------------------------------
// Whether a GSTIN is registered and active in Customs' copy of GSTN data. Same session pattern as CODES.
export function parseGstin(html: string) {
  const m = /<b[^>]*>\s*GSTIN ID\s*=([\s\S]*?)<\/b>/i.exec(html);
  if (!m) return undefined;
  const parts = m[1]!.split(/<br\s*\/?>/i).map(decode).filter(Boolean);
  const gstin = parts.shift()!;
  const text = parts.join(" ");
  const available = /is active and available with Customs/i.test(text);
  return {
    gstin,
    available,
    legalName: available ? parts[0] : undefined,
    lastUpdateFromGstn: /Last update[^:]*:\s*(\d{2}\/\d{2}\/\d{4})/i.exec(text)?.[1],
    message: available ? undefined : text,
  };
}

export async function gstinLookup(gstin: string) {
  const g = gstin.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const start = await ok({ method: "GET", url: `${WEBAPPL}/GSTN` });
  const cookie = start.setCookie.map((c) => c.split(";")[0]).join("; ");
  const res = await ok({ method: "POST", url: `${WEBAPPL}/GSTN-Number-Enquiry`, form: { gstn_no: g, submitbutton: "Search" }, cookie, referer: `${WEBAPPL}/GSTN` });
  const r = parseGstin(res.body);
  if (!r) throw new IcegateError("No record found.", 200, "not_found");
  return r;
}

// --- Trade Guides on Exports / Imports ---------------------------------------
// Each page's own JS calls two JSON endpoints with GET; no session needed.
const GUIDE = {
  export: { items: "Desc_details_itchs", notes: "DescdetailsNotesItchs" },
  import: { items: "Desc_details", notes: "Desc_details_Notes" },
} as const;
const qs = (cth?: string, desc?: string) => new URLSearchParams({ cth: cth ?? "", item_desc: desc?.toUpperCase() ?? "" }).toString();

async function json(path: string) {
  const res = await ok({ method: "GET", url: `${WEBAPPL}/${path}` });
  if (!res.body.trim()) return {};
  try { return JSON.parse(res.body); } catch { throw new IcegateError("Unexpected non-JSON reply from Trade Guide.", res.status, "http"); }
}

export async function tradeGuide(q: { cth?: string; description?: string; notes?: boolean; kind?: keyof typeof GUIDE }) {
  if (!q.cth && !q.description) throw new IcegateError("Provide an ITC(HS) code prefix or a description.", 0, "invalid");
  const kind = q.kind ?? "export", ep = GUIDE[kind];
  const policy = kind === "export" ? "exportPolicy" : "importPolicy";
  const items = ((await json(`${ep.items}?${qs(q.cth, q.description)}`)).rsAllCth ?? []).map((i: any) => ({
    code: i.itc_code, description: i.itc_desc?.trim(), [policy]: i.itchs_policy, unit: i.uqc, tariffRate: i.rta,
  }));
  if (!q.notes || !q.cth) return { items };
  const n = await json(`${ep.notes}?${qs(q.cth, q.description)}`);
  const sec = n.rs_sec_chaptr?.[0];
  // rs_sec_chaptr2 holds export-policy conditions on the export guide and sub-heading notes on the import guide.
  const second = (n.rs_sec_chaptr2 ?? []).map((x: any) => x.subhead_notes);
  return {
    items,
    section: sec && { section: sec.section, sectionTitle: sec.sec_details, chapter: sec.chapter, chapterTitle: sec.chap_details },
    chapterNotes: (n.rs_sec_chaptr1 ?? []).map((x: any) => x.main_notes),
    ...(kind === "export" ? { policyConditions: second } : { subheadingNotes: second }),
    otherNotes: [...(n.rs_sec_chaptr3 ?? []).map((x: any) => x.suppl_notes ?? x), ...(n.rs_sec_chaptr4 ?? []).map((x: any) => x.oth_notes ?? x)],
  };
}
