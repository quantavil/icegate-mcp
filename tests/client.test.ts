import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BASE, IcegateError, allLocations, dmyToIso, enquiry, fmt, get, notifications, post } from "../src/client.ts";
import { mockFetch } from "./helpers.ts";

let m: ReturnType<typeof mockFetch>;
let reply: Parameters<typeof mockFetch>[0];
beforeEach(() => { reply = () => ({ body: {} }); m = mockFetch((u, c) => reply(u, c)); });
afterEach(() => m.restore());

const kindOf = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as IcegateError; } throw new Error("did not throw"); };

describe("fmt", () => {
  test("formats", () => {
    expect(fmt.compact("2026-03-07")).toBe("20260307");
    expect(fmt.slash("2026-03-07")).toBe("2026/03/07");
    expect(fmt.dmy("2026-03-07")).toBe("07-03-2026");
    expect(fmt.oracle("2026-03-07")).toBe("07-MAR-26");
    expect(fmt.oracle("2026-12-31")).toBe("31-DEC-26");
  });
  test("bad input throws invalid IcegateError", () => {
    for (const bad of ["", "2026-3-7", "07-03-2026", "20260307", "2026-03-07T00:00", "abc", " 2026-03-07"])
      for (const f of Object.values(fmt)) {
        try { f(bad); throw new Error("no throw " + bad); } catch (e) {
          expect(e).toBeInstanceOf(IcegateError);
          expect((e as IcegateError).kind).toBe("invalid");
        }
      }
  });
  test("rejects impossible calendar dates", () => {
    for (const bad of ["2026-13-01", "2026-00-10", "2026-02-30", "2026-04-31", "2026-01-00", "2025-02-29"])
      for (const f of Object.values(fmt)) expect(() => f(bad)).toThrow(IcegateError);
    expect(fmt.compact("2028-02-29")).toBe("20280229");
  });
  test("dmyToIso", () => expect(dmyToIso("07-03-2026")).toBe("2026-03-07"));
});

describe("request", () => {
  test("builds URLs, methods, headers, bodies", async () => {
    reply = () => ({ body: { ok: 1 } });
    expect(await get("a/b")).toEqual({ ok: 1 });
    await post("c/d", { x: 1 });
    await post("c/e");
    await enquiry("meth", { y: 2 });
    expect(m.calls.map((c) => [c.method, c.url, c.body])).toEqual([
      ["GET", `${BASE}/a/b`, undefined],
      ["POST", `${BASE}/c/d`, { x: 1 }],
      ["POST", `${BASE}/c/e`, {}],
      ["POST", `${BASE}/enquiry/publicEnquiries/meth`, { y: 2 }],
    ]);
  });
  test("404 No Record Found -> not_found", async () => {
    reply = () => ({ status: 404, body: { message: "No Record Found !!" } });
    const e = await kindOf(get("x"));
    expect(e).toBeInstanceOf(IcegateError);
    expect([e.kind, e.status]).toEqual(["not_found", 404]);
  });
  test("no-record text on other status -> not_found", async () => {
    reply = () => ({ status: 400, body: { message: "no record found" } });
    expect((await kindOf(get("x"))).kind).toBe("not_found");
  });
  test("400 auth error -> login_required", async () => {
    reply = () => ({ status: 400, body: { message: "auth error..!!!" } });
    const e = await kindOf(get("x"));
    expect([e.kind, e.status]).toEqual(["login_required", 400]);
  });
  test("400 errorCode/errors[] -> invalid with message", async () => {
    reply = () => ({ status: 400, body: { errorCode: "E1", errors: ["bad date", "bad loc"] } });
    const e = await kindOf(get("x"));
    expect(e.kind).toBe("invalid");
    expect(e.message).toBe("bad date; bad loc");
  });
  test("500 -> http", async () => {
    reply = () => ({ status: 500, body: { message: "boom" } });
    const e = await kindOf(get("x"));
    expect([e.kind, e.status, e.message]).toEqual(["http", 500, "boom"]);
  });
  test("non-JSON bodies", async () => {
    reply = () => ({ status: 502, text: "<html>Bad Gateway</html>" });
    const e = await kindOf(get("x"));
    expect([e.kind, e.message]).toEqual(["http", "<html>Bad Gateway</html>"]);
    reply = () => ({ status: 200, text: "plain ok" });
    expect(await get("x")).toBe("plain ok");
    reply = () => ({ status: 200, text: "" });
    expect(await get("x")).toBeNull();
    reply = () => ({ status: 500, text: "" });
    expect((await kindOf(get("x"))).message).toBe("ERR");
  });
  test("JSON null / empty-object error bodies do not crash", async () => {
    reply = () => ({ status: 400, text: "null" });
    expect((await kindOf(get("x"))).kind).toBe("invalid");
    reply = () => ({ status: 500, body: {} });
    expect((await kindOf(get("x"))).kind).toBe("http");
  });
});

describe("notifications", () => {
  test("sorts newest first and converts dates", async () => {
    reply = () => ({ body: [
      { notificationNumber: "10/2026", notPublishDate: "05-02-2026" },
      { notificationNumber: "30/2026", notPublishDate: "20-10-2026" },
      { notificationNumber: "20/2026", notPublishDate: "01-07-2026" },
    ] });
    expect(await notifications()).toEqual([
      { number: "30/2026", published: "2026-10-20" },
      { number: "20/2026", published: "2026-07-01" },
      { number: "10/2026", published: "2026-02-05" },
    ]);
    expect(m.calls[0]!.url).toBe(`${BASE}/cbu/icegateapi/getnotdetails`);
    expect(m.calls[0]!.method).toBe("POST");
  });
  test("empty / non-array response gives empty list", async () => {
    reply = () => ({ body: [] });
    expect(await notifications()).toEqual([]);
    reply = () => ({ body: null });
    expect(await notifications()).toEqual([]);
  });
});

describe("allLocations", () => {
  test("failed fetch is not cached", async () => {
    reply = () => ({ status: 500, body: { message: "down" } });
    expect((await kindOf(allLocations())).kind).toBe("http");
    reply = () => ({ body: { response: [{ locationCode: "INNSA1", locationName: "NHAVA SHEVA" }] } });
    expect(await allLocations()).toEqual([{ code: "INNSA1", name: "NHAVA SHEVA" }]);
    expect(m.calls).toHaveLength(2);
  });
  test("successful result is cached", async () => {
    reply = () => ({ body: { response: [{ locationCode: "INMUN1", locationName: "MUNDRA" }] } });
    const [a, b] = [await allLocations(), await allLocations()];
    expect(a).toBe(b);
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0]!.url).toBe(`${BASE}/codename/allGobalLocations`);
    expect(m.calls[0]!.method).toBe("GET");
  });
});
