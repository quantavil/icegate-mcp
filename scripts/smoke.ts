// Live smoke test: spawn the server over stdio and call each tool once.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "smoke", version: "0" });
await client.connect(new StdioClientTransport({ command: "bun", args: ["src/index.ts"] }));
const { tools } = await client.listTools();
console.log("tools:", tools.map((t) => t.name).join(", "));

const calls: [string, Record<string, unknown>][] = [
  ["icegate_find_location", { query: "nhava", limit: 3 }],
  ["icegate_exchange_rates", { currencies: ["USD", "EUR"] }],
  ["icegate_exchange_rates", { date: "2026-08-10", currencies: ["USD"] }],
  ["icegate_exchange_rate_notifications", { limit: 3 }],
  ["icegate_available_enquiries", {}],
  ["icegate_shipping_bill_status", { location: "INNSA1", sbNo: "1234567", sbDate: "2026-10-01" }],
  ["icegate_sb_rbi_edpms_status", { location: "INNSA1", sbNo: "1234567", sbDate: "2026-10-01" }],
  ["icegate_sb_dgft_status", { location: "INNSA1", sbNo: "1234567", sbDate: "2026-10-01" }],
  ["icegate_be_gstn_transmission", { portCode: "INNSA1", beNo: "1234567", beDate: "2026-10-01" }],
  ["icegate_challan_enquiry", { challanNo: "1", docNo: "1234567", docDate: "2026-10-01" }],
  ["icegate_vessel_rotation", { imoCode: "9321483", fromDate: "2026-09-01", toDate: "2026-10-01" }],
  ["icegate_warehouse_code", { name: "CONTINENTAL" }],
  ["icegate_warehouse_code", { code: "NSA1U008" }],
  ["icegate_postal_article", { articleId: "EE123456789IN" }],
  ["icegate_sez_ports", {}],
  ["icegate_codes_lookup", { table: "country", code: "DE" }],
  ["icegate_trade_guide_exports", { cth: "0901", notes: true, limit: 3 }],
];
for (const [name, args] of calls) {
  const r: any = await client.callTool({ name, arguments: args });
  console.log(`\n## ${name}${r.isError ? " [ERROR]" : ""}\n${r.content[0].text.slice(0, 400)}`);
}
await client.close();
