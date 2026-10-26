// MCP server for ICEGATE (Indian Customs) public enquiries — no login, no captcha.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { IcegateError, allLocations, enquiry, fmt, get, notifications, post } from "./client.ts";
import { CODES, type CodeTable, codesLookup, gstinLookup, importDuty, tradeGuide } from "./webappl.ts";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Date as YYYY-MM-DD");
const location = z.string().min(3).describe("Customs location/port code, e.g. INNSA1 (Nhava Sheva). Use icegate_find_location to look one up.");
const ro = { readOnlyHint: true, openWorldHint: true } as const;

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };
async function run(fn: () => Promise<unknown>): Promise<Result> {
  try {
    const data = await fn();
    return { content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] };
  } catch (e) {
    if (e instanceof IcegateError && e.kind === "not_found") return { content: [{ type: "text", text: "No record found on ICEGATE for these inputs. Check the number, date and location code." }] };
    const msg = e instanceof Error ? e.message : String(e);
    return { content: [{ type: "text", text: `ICEGATE error: ${msg}` }], isError: true };
  }
}

// Drop empty sub-sections so the model sees only what ICEGATE actually returned.
function compact(obj: unknown) {
  const out = Object.fromEntries(Object.entries(obj && typeof obj === "object" ? obj : {}).filter(([, v]) => !(Array.isArray(v) && v.length === 0) && v != null));
  if (Object.keys(out).length === 0) throw new IcegateError("No record found.", 200, "not_found");
  return out;
}

export function createServer() {
  const server = new McpServer({ name: "icegate", version: "0.3.0" });

  server.registerTool("icegate_find_location", {
    title: "Find customs location code",
    description: "Search ICEGATE's customs location/port master (seaports, ICDs, air cargo, LCS) by code or name fragment. Returns {code,name} pairs.",
    inputSchema: { query: z.string().min(2).describe("Code or part of name, e.g. 'nhava', 'INDEL4', 'mundra'"), limit: z.number().int().min(1).max(200).default(25) },
    annotations: ro,
  }, ({ query, limit }) => run(async () => {
    const q = query.toLowerCase();
    const all = await allLocations();
    const hits = all.filter((l) => l.code?.toLowerCase().includes(q) || l.name?.toLowerCase().includes(q));
    return { total: hits.length, results: hits.slice(0, limit) };
  }));

  server.registerTool("icegate_shipping_bill_status", {
    title: "Shipping Bill status",
    description: "Track an export Shipping Bill on ICES: SB details, current status, EGM, gateway EGM, drawback queries, RoSL/RoDTEP, IGST invoice details, OGA, payments and e-docs.",
    inputSchema: { location, sbNo: z.string().min(1).describe("Shipping Bill number"), sbDate: isoDate },
    annotations: ro,
  }, ({ location, sbNo, sbDate }) => run(async () =>
    compact(await enquiry("SBTrack_Ices_action_Public", { location: location.toUpperCase(), sbNo, sbDate: fmt.compact(sbDate) }))));

  server.registerTool("icegate_sb_rbi_edpms_status", {
    title: "Shipping Bill status in RBI EDPMS",
    description: "Check whether a Shipping Bill has reached RBI's EDPMS (export data processing & monitoring system).",
    inputSchema: { location, sbNo: z.string().min(1), sbDate: isoDate },
    annotations: ro,
  }, ({ location, sbNo, sbDate }) => run(() =>
    enquiry("rbiSBStatusPublic", { location: location.toUpperCase(), sbNumber: sbNo, sbDate: fmt.slash(sbDate), isLoggedIn: false })));

  server.registerTool("icegate_sb_dgft_status", {
    title: "Shipping Bill DGFT integration status",
    description: "Status of a Shipping Bill's transmission/integration with DGFT.",
    inputSchema: { location, sbNo: z.string().min(1), sbDate: isoDate },
    annotations: ro,
  }, ({ location, sbNo, sbDate }) => run(() =>
    enquiry("public-dgft-code-entry-iec", { location: location.toUpperCase(), sbNo, sbDate: fmt.slash(sbDate) })));

  server.registerTool("icegate_be_gstn_transmission", {
    title: "Bill of Entry transmission to GSTN",
    description: "Whether an import Bill of Entry has been transmitted to GSTN (relevant for IGST ITC in GSTR-2B). Note: full public BE status tracking now needs an ICEGATE login.",
    inputSchema: { portCode: location, beNo: z.string().min(1).describe("Bill of Entry number"), beDate: isoDate },
    annotations: ro,
  }, ({ portCode, beNo, beDate }) => run(() =>
    enquiry("public-sts-betrnsmsn-gstn", { portCode: portCode.toUpperCase(), beNumber: beNo, beDate: fmt.slash(beDate) })));

  server.registerTool("icegate_challan_enquiry", {
    title: "Customs duty challan (bank) enquiry",
    description: "Bank payment status of a customs duty challan against a document (BE/SB).",
    inputSchema: { challanNo: z.string().min(1), docNo: z.string().min(1).describe("Document number (e.g. BE number)"), docDate: isoDate },
    annotations: ro,
  }, ({ challanNo, docNo, docDate }) => run(() =>
    enquiry("publicChallanBankEnquiry", { challanNo, docNo, docDate: fmt.oracle(docDate) })));

  server.registerTool("icegate_vessel_rotation", {
    title: "Vessel rotation / VCN enquiry",
    description: "Vessel call numbers (VCN / rotation numbers) for a vessel IMO code within a date range.",
    inputSchema: { imoCode: z.string().min(1).describe("Vessel IMO number"), fromDate: isoDate, toDate: isoDate },
    annotations: ro,
  }, ({ imoCode, fromDate, toDate }) => run(() =>
    enquiry("public-vcn-enquiry", { imoCode, vcnStartDate: fmt.oracle(fromDate), vcnEndDate: fmt.oracle(toDate) })));

  server.registerTool("icegate_warehouse_code", {
    title: "Customs warehouse code enquiry",
    description: "Look up a bonded warehouse by code and/or name. Provide at least one.",
    inputSchema: { code: z.string().max(8).optional().describe("Warehouse code, e.g. NSA1U008"), name: z.string().max(50).optional().describe("Name fragment, e.g. CONTINENTAL") },
    annotations: ro,
  }, ({ code, name }) => run(() => {
    if (!code && !name) throw new IcegateError("Provide a warehouse code or name.", 0, "invalid");
    // ICEGATE rejects empty strings; omit whichever field is unused.
    return enquiry("warehousecode", { ...(code && { wareHouseCode: code.toUpperCase() }), ...(name && { wareHouseName: name }) });
  }));

  server.registerTool("icegate_postal_article", {
    title: "Track postal import article",
    description: "Customs status of an India Post import article (postal parcel).",
    inputSchema: { articleId: z.string().min(1).describe("India Post article / tracking ID") },
    annotations: ro,
  }, ({ articleId }) => run(() => enquiry("postalImport/trackArticle", { articleId })));

  server.registerTool("icegate_exchange_rates", {
    title: "CBIC customs exchange rates",
    description: "CBIC-notified customs exchange rates (INR per unit) for import and export. Picks the notification in force on the given date (default: latest), or a specific notification number.",
    inputSchema: {
      date: isoDate.optional().describe("Date the rate should apply to (YYYY-MM-DD); default today"),
      notification: z.string().regex(/^\d+\/\d{4}$/).optional().describe("Specific notification, e.g. '29/2026'"),
      currencies: z.array(z.string().length(3)).optional().describe("Filter, e.g. ['USD','EUR']"),
    },
    annotations: ro,
  }, ({ date, notification, currencies }) => run(async () => {
    let num = notification;
    if (!num) {
      const on = date ?? new Date().toISOString().slice(0, 10);
      const list = await notifications();
      const hit = list.find((n) => n.published <= on);
      if (!hit) throw new IcegateError(`No exchange-rate notification found on or before ${on}.`, 0, "invalid");
      num = hit.number;
    }
    const r = (await post("cbu/icegateapi/igexratepublishnot", { notNum: num })) as any;
    const want = currencies?.map((c) => c.toUpperCase());
    const rates = (r.currencyDetail ?? [])
      .filter((c: any) => !want || want.includes(c.currencyCode))
      .map((c: any) => ({ currency: c.currencyCode, name: c.currencyDesc, units: Number(c.units), import: c.cbicImport, export: c.cbicExport }));
    return { notification: r.notificationNumber ?? num, published: r.notPublishDate, rates };
  }));

  server.registerTool("icegate_exchange_rate_notifications", {
    title: "List exchange-rate notifications",
    description: "List CBIC customs exchange-rate notifications (number and publish date), newest first.",
    inputSchema: { limit: z.number().int().min(1).max(500).default(20) },
    annotations: ro,
  }, ({ limit }) => run(async () => (await notifications()).slice(0, limit)));

  server.registerTool("icegate_available_enquiries", {
    title: "List ICEGATE public enquiries",
    description: "Which public enquiries ICEGATE currently has enabled (live from the portal).",
    inputSchema: {},
    annotations: ro,
  }, () => run(() => enquiry("allEnquiriesPublic", { isLoggedIn: false, icegateId: 0, roleId: 0 })));

  server.registerTool("icegate_public_enquiry_raw", {
    title: "Raw ICEGATE public enquiry",
    description: "Escape hatch: POST a JSON body to any ICEGATE 2.0 public enquiry method (https://foservices.icegate.gov.in/enquiry/publicEnquiries/<method>). Use when no dedicated tool exists, e.g. airIgmFlightDetailsPublic {igmNo,igmDate,location,isLoggedIn:false}, public-air-consol-master {locationCode,masterBlNumber}, publicblstatus-action {mawbNumber,hawbNumber}, be-ack-public-status / rlo-public-status {location,agencyCd,billEntryNo,billEntryDt}, ctd-details {siteId,ctdNo,ctdType,ctdDt}. Dates usually yyyy/MM/dd. Read-only enquiries only.",
    inputSchema: { method: z.string().regex(/^[A-Za-z0-9_\-\/]+$/).refine((m) => !m.includes(".."), "invalid path"), body: z.record(z.string(), z.unknown()) },
    annotations: ro,
  }, ({ method, body }) => run(() => enquiry(method, body)));

  server.registerTool("icegate_sez_ports", {
    title: "List SEZ ports",
    description: "List SEZ customs locations from ICEGATE.",
    inputSchema: {},
    annotations: ro,
  }, () => run(() => get("codename/getSezPortPublic")));

  const tables = Object.keys(CODES) as [CodeTable, ...CodeTable[]];
  server.registerTool("icegate_codes_lookup", {
    title: "ICEGATE CODES directory lookup",
    description: "Search ICEGATE's Customs Online Directory Enquiry System (CODES, www.icegate.gov.in/Webappl/Codes). Tables: "
      + Object.entries(CODES).map(([k, v]) => `${k} — ${v.label}`).join("; ")
      + ". Search by code and/or name fragment (case-insensitive). 'tariff' accepts code only; 'location' accepts name only.",
    inputSchema: {
      table: z.enum(tables),
      code: z.string().max(30).optional().describe("Code or code fragment, e.g. '0901' for tariff, 'EUR' for currency"),
      name: z.string().max(30).optional().describe("Name/description fragment, e.g. 'NHAVA', 'GERMANY', 'KILO'"),
      limit: z.number().int().min(1).max(500).default(100),
    },
    annotations: ro,
  }, ({ table, code, name, limit }) => run(async () => {
    const rows = await codesLookup(table, { code, name });
    if (rows.length === 0) throw new IcegateError("No record found.", 200, "not_found");
    return { total: rows.length, rows: rows.slice(0, limit) };
  }));

  server.registerTool("icegate_trade_guide_exports", {
    title: "Trade Guide on Exports (ITC-HS)",
    description: "ICEGATE Trade Guide on Exports (www.icegate.gov.in/Webappl/Trade-Guide-on-Exports): ITC(HS) items matching a code prefix or description, with export policy (Free/Restricted/Prohibited), unit and tariff rate. With notes=true and a code, also returns section/chapter, chapter notes and export-policy conditions.",
    inputSchema: {
      cth: z.string().regex(/^\d{2,8}$/).optional().describe("ITC(HS) code prefix, 2–8 digits, e.g. '0901'"),
      description: z.string().max(60).optional().describe("Description fragment, e.g. 'COFFEE'"),
      notes: z.boolean().default(false),
      limit: z.number().int().min(1).max(500).default(100),
    },
    annotations: ro,
  }, ({ cth, description, notes, limit }) => run(async () => {
    const r = await tradeGuide({ cth, description, notes });
    if (r.items.length === 0) throw new IcegateError("No record found.", 200, "not_found");
    return { ...r, total: r.items.length, items: r.items.slice(0, limit) };
  }));

  server.registerTool("icegate_trade_guide_imports", {
    title: "Trade Guide on Imports (ITC-HS)",
    description: "ICEGATE Trade Guide on Imports / Know your Import Duty (www.icegate.gov.in/Webappl/Trade-Guide-on-Imports): ITC(HS) items matching a code prefix or description, with import policy (Free/Restricted/Prohibited), unit and tariff (BCD) rate. With notes=true and a code, also returns section/chapter, chapter notes and sub-heading notes.",
    inputSchema: {
      cth: z.string().regex(/^\d{2,8}$/).optional().describe("ITC(HS) code prefix, 2–8 digits, e.g. '8517'"),
      description: z.string().max(60).optional().describe("Description fragment, e.g. 'COFFEE'"),
      notes: z.boolean().default(false),
      limit: z.number().int().min(1).max(500).default(100),
    },
    annotations: ro,
  }, ({ cth, description, notes, limit }) => run(async () => {
    const r = await tradeGuide({ cth, description, notes, kind: "import" });
    if (r.items.length === 0) throw new IcegateError("No record found.", 200, "not_found");
    return { ...r, total: r.items.length, items: r.items.slice(0, limit) };
  }));

  server.registerTool("icegate_import_duty", {
    title: "Import duty structure for a tariff item",
    description: "ICEGATE 'Know your Import Duty' for an 8-digit CTH: tariff vs effective rate per duty head (BCD, AIDC, SWS, IGST, cesses, ADD/safeguard), governing notification, specific duties, import-policy notes, and the total ad-valorem duty % (optionally applied to an assessable value in INR). Indicative; the BE assessment is authoritative. Use icegate_trade_guide_imports to find the 8-digit code first.",
    inputSchema: {
      cth: z.string().regex(/^\d{8}$/).describe("8-digit tariff item, e.g. '85171300'"),
      assessableValue: z.number().positive().optional().describe("Assessable value in INR (CIF + landing); returns duty amounts"),
      country: z.string().max(60).optional().describe("Country of origin as ICEGATE's 'CODE,NAME' (e.g. 'JP,JAPAN'). Currently does not change rates."),
      exemptions: z.boolean().default(false).describe("Also list candidate exemption notifications per head (up to 50 each)"),
    },
    annotations: ro,
  }, ({ cth, assessableValue, country, exemptions }) => run(() => importDuty({ cth, assessableValue, country, exemptions })));

  server.registerTool("icegate_gstin_status", {
    title: "GSTIN status with Customs",
    description: "Check whether a GSTIN is active and available with Customs (ICEGATE CODES GSTIN enquiry, www.icegate.gov.in/Webappl/GSTN). Returns legal name and the last date Customs received an update for it from GSTN. 'Not available' means Customs has no active record (e.g. cancelled, new, or not yet synced).",
    inputSchema: { gstin: z.string().regex(/^[0-9]{2}[A-Za-z0-9]{13}$/, "GSTIN is 15 characters: 2-digit state code + PAN + 3 chars").describe("15-character GSTIN, e.g. 27AAACR5055K1Z7") },
    annotations: ro,
  }, ({ gstin }) => run(() => gstinLookup(gstin)));

  return server;
}
