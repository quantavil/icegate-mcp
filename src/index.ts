#!/usr/bin/env bun
// MCP server for ICEGATE (Indian Customs) public enquiries — no login, no captcha.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.ts";

await createServer().connect(new StdioServerTransport());
console.error("icegate MCP server running on stdio");
