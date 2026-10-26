// Thin client for ICEGATE 2.0 public (no-login, no-captcha) APIs on foservices.icegate.gov.in.

export const BASE = process.env.ICEGATE_BASE_URL ?? "https://foservices.icegate.gov.in";
const ENQ = `${BASE}/enquiry/publicEnquiries`;
const TIMEOUT_MS = Number(process.env.ICEGATE_TIMEOUT_MS ?? 30000);

export class IcegateError extends Error {
  constructor(message: string, readonly status: number, readonly kind: "not_found" | "login_required" | "invalid" | "http") {
    super(message);
  }
}

const HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US",
  channel: "browser",
  Origin: BASE,
  Referer: `${BASE}/`,
  "User-Agent": "icegate-mcp/0.1 (+public enquiry client)",
};

async function request(method: "GET" | "POST", url: string, body?: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method,
    headers: HEADERS,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  let data: any;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  const msg: string =
    (data && typeof data === "object" && (data.message ?? data.errors?.join("; "))) ||
    (typeof data === "string" ? data.slice(0, 300) : "") ||
    res.statusText;
  if (/auth error/i.test(msg)) throw new IcegateError("ICEGATE now requires login for this enquiry.", res.status, "login_required");
  if (res.status === 404 || /no record found/i.test(msg)) throw new IcegateError("No record found.", res.status, "not_found");
  if (!res.ok) throw new IcegateError(msg || `HTTP ${res.status}`, res.status, res.status === 400 ? "invalid" : "http");
  return data;
}

export const get = (path: string) => request("GET", `${BASE}/${path}`);
export const post = (path: string, body: unknown = {}) => request("POST", `${BASE}/${path}`, body);
export const enquiry = (method: string, body: unknown) => request("POST", `${ENQ}/${method}`, body);

// Dates: tools take ISO YYYY-MM-DD; each ICEGATE endpoint wants its own format.
const MON = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
function parts(iso: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m || new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!)).toISOString().slice(0, 10) !== iso) throw new IcegateError(`Date must be a valid YYYY-MM-DD, got "${iso}"`, 0, "invalid");
  return { y: m[1]!, m: m[2]!, d: m[3]! };
}
export const fmt = {
  compact: (iso: string) => { const p = parts(iso); return `${p.y}${p.m}${p.d}`; },      // yyyyMMdd
  slash: (iso: string) => { const p = parts(iso); return `${p.y}/${p.m}/${p.d}`; },       // yyyy/MM/dd
  dmy: (iso: string) => { const p = parts(iso); return `${p.d}-${p.m}-${p.y}`; },         // dd-MM-yyyy
  oracle: (iso: string) => { const p = parts(iso); return `${p.d}-${MON[+p.m - 1]}-${p.y.slice(2)}`; }, // dd-MMM-yy
};
export const dmyToIso = (s: string) => { const [d, m, y] = s.split("-"); return `${y}-${m}-${d}`; };

// Master data, cached for the life of the process.
let locations: Promise<{ code: string; name: string }[]> | undefined;
export const clearLocations = () => { locations = undefined; };
export function allLocations() {
  locations ??= (get("codename/allGobalLocations") as Promise<any>)
    .then((r) => (r?.response ?? []).map((l: any) => ({ code: l.locationCode, name: l.locationName })))
    .catch((e) => { locations = undefined; throw e; });
  return locations;
}

export async function notifications(): Promise<{ number: string; published: string }[]> {
  const list = (await post("cbu/icegateapi/getnotdetails", {})) as any[] | null;
  return (Array.isArray(list) ? list : [])
    .map((n) => ({ number: n.notificationNumber as string, published: dmyToIso(n.notPublishDate) }))
    .sort((a, b) => b.published.localeCompare(a.published));
}
