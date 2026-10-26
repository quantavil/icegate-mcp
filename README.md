# icegate-mcp

MCP server for the public (no-login) enquiries of [ICEGATE](https://www.icegate.gov.in/), India's Customs gateway. It calls the ICEGATE 2.0 JSON APIs on `foservices.icegate.gov.in` directly; none of these need a login or captcha.

## Tools

| Tool | What it does |
|---|---|
| `icegate_find_location` | Search customs location/port codes (e.g. "nhava" → `INNSA1`) |
| `icegate_shipping_bill_status` | Full SB tracking: details, current status, EGM, drawback, RoSL/RoDTEP, IGST invoices, OGA, e-docs |
| `icegate_sb_rbi_edpms_status` | SB status in RBI EDPMS |
| `icegate_sb_dgft_status` | SB integration status with DGFT |
| `icegate_be_gstn_transmission` | Whether a Bill of Entry was transmitted to GSTN |
| `icegate_challan_enquiry` | Duty challan bank status |
| `icegate_vessel_rotation` | VCN / rotation numbers for a vessel IMO in a date range |
| `icegate_warehouse_code` | Bonded warehouse lookup by code or name |
| `icegate_postal_article` | Customs status of an India Post import article |
| `icegate_exchange_rates` | CBIC customs exchange rates (import/export) in force on a date, or by notification |
| `icegate_exchange_rate_notifications` | List exchange-rate notifications |
| `icegate_available_enquiries` | Public enquiries ICEGATE currently has enabled |
| `icegate_sez_ports` | SEZ location list |
| `icegate_public_enquiry_raw` | Call any other `publicEnquiries/<method>` (air IGM, consol, ICD BL, OGA ack, CTD) |
| `icegate_codes_lookup` | [CODES directory](https://www.icegate.gov.in/Webappl/Codes): tariff (CTH + BCD rate), ITC(HS), location, currency, country, state, UQC, package, sea/air port, airline, shipping line, supporting-document codes |
| `icegate_trade_guide_exports` | [Trade Guide on Exports](https://www.icegate.gov.in/Webappl/Trade-Guide-on-Exports): ITC(HS) items with export policy, unit and tariff rate, plus chapter notes and policy conditions |
| `icegate_trade_guide_imports` | [Trade Guide on Imports](https://www.icegate.gov.in/Webappl/Trade-Guide-on-Imports): ITC(HS) items with import policy, unit and BCD rate, plus chapter and sub-heading notes |
| `icegate_import_duty` | "Know your Import Duty" for an 8-digit CTH: tariff vs effective rate per head (BCD, AIDC, SWS, IGST, cesses, ADD/safeguard), governing notification, exemption notifications, policy notes, total duty % and duty on an assessable value |
| `icegate_gstin_status` | [GSTIN enquiry](https://www.icegate.gov.in/Webappl/GSTN): whether a GSTIN is active with Customs, legal name, last GSTN update |

`icegate_import_duty` reproduces the duty page's own formula (e.g. 85171300 smartphones: 49.152% = BCD 20 + AIDC 4 + SWS 2.4 + IGST 22.752). It is indicative: specific duties are listed but not added into the % total, and ICEGATE currently returns no preferential/FTA rates even when a country of origin is given.

The CODES, trade-guide, duty and GSTIN tools use the legacy `www.icegate.gov.in/Webappl` pages. That host omits its intermediate TLS certificate, so the server ships it ([src/ca.ts](src/ca.ts), expires 2027-12-10) and keeps verification on. The `/Webappl/` landing page itself has a CAPTCHA, but these pages don't need it; the server never solves CAPTCHAs.

All dates go in as `YYYY-MM-DD`; the server converts them to each endpoint's format.

Not available without login (ICEGATE returns "auth error"): Bill of Entry status tracking, FE realization, IGST refund/scroll, drawback, IEC details. Those need an ICEGATE account and are out of scope.

## Install

Requires [Bun](https://bun.sh). Run straight from GitHub, no clone needed:

```bash
bunx github:quantavil/icegate-mcp
```

Claude Code:

```bash
claude mcp add --scope user icegate -- bunx github:quantavil/icegate-mcp
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.icegate]
command = "bunx"
args = ["github:quantavil/icegate-mcp"]
```

Claude Desktop (`claude_desktop_config.json`):

```json
{ "mcpServers": { "icegate": { "command": "bunx", "args": ["github:quantavil/icegate-mcp"] } } }
```

Or build a one-click Desktop extension that runs on Node (no Bun needed): `bun run pack:mcpb`, then open `icegate.mcpb`.

## Develop

```bash
bun install
bun test             # unit + in-process server tests (ICEGATE mocked)
bun run test:live    # adds a few live requests to ICEGATE
```

## Config

- `ICEGATE_BASE_URL` (default `https://foservices.icegate.gov.in`)
- `ICEGATE_WEBAPPL_URL` (default `https://www.icegate.gov.in/Webappl`)
- `ICEGATE_TIMEOUT_MS` (default `30000`)

## License

[GPL-3.0-or-later](LICENSE). Not affiliated with CBIC or ICEGATE.
