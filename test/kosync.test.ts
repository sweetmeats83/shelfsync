import { describe, it, expect, beforeEach, vi } from "vitest";
import { openDb } from "../src/db.js";
import { kosyncRoutes } from "../src/kosync.js";

const KEY = "5f4dcc3b5aa765d61d8327deb882cf99"; // md5("password"), as KOReader sends it
const auth = { "x-auth-user": "nick", "x-auth-key": KEY, "content-type": "application/json" };
const put = (app: ReturnType<typeof kosyncRoutes>, body: object, headers = auth) =>
  app.request("/syncs/progress", { method: "PUT", headers, body: JSON.stringify(body) });

function setup(registrationDisabled = false) {
  const onProgress = vi.fn();
  const app = kosyncRoutes({ db: openDb(":memory:"), registrationDisabled, onProgress });
  return { app, onProgress };
}
const create = (app: ReturnType<typeof kosyncRoutes>) =>
  app.request("/users/create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "nick", password: KEY }),
  });

describe("kosync", () => {
  let app: ReturnType<typeof kosyncRoutes>;
  let onProgress: ReturnType<typeof vi.fn>;
  beforeEach(() => ({ app, onProgress } = setup()));

  it("healthcheck", async () => {
    const r = await app.request("/healthcheck");
    expect(await r.json()).toEqual({ state: "OK" });
  });

  it("creates a user, then rejects a duplicate with 402/2002", async () => {
    const r1 = await create(app);
    expect(r1.status).toBe(201);
    expect(await r1.json()).toEqual({ username: "nick" });
    const r2 = await create(app);
    expect(r2.status).toBe(402);
    expect(await r2.json()).toEqual({ code: 2002, message: "Username is already registered." });
  });

  it("blocks registration when disabled", async () => {
    const s = setup(true);
    expect((await create(s.app)).status).toBe(402);
  });

  it("auth ok / bad key / unknown user", async () => {
    await create(app);
    const ok = await app.request("/users/auth", { headers: auth });
    expect(await ok.json()).toEqual({ authorized: "OK" });
    const bad = await app.request("/users/auth", { headers: { ...auth, "x-auth-key": "nope" } });
    expect(bad.status).toBe(401);
    expect(await bad.json()).toEqual({ code: 2001, message: "Unauthorized" });
    const none = await app.request("/users/auth", { headers: { ...auth, "x-auth-user": "x" } });
    expect(none.status).toBe(401);
  });

  it("PUT then GET returns the newest position across devices", async () => {
    await create(app);
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000_000_000);
    const a = await put(app, { document: "d1", progress: "10", percentage: 0.1, device: "Kobo", device_id: "A" });
    expect(await a.json()).toEqual({ document: "d1", timestamp: 1_000_000_000 });
    vi.setSystemTime(1_000_000_100_000);
    await put(app, { document: "d1", progress: "50", percentage: 0.5, device: "Phone", device_id: "B" });
    vi.useRealTimers();

    const r = await app.request("/syncs/progress/d1", { headers: auth });
    expect(await r.json()).toEqual({
      document: "d1", progress: "50", percentage: 0.5,
      device: "Phone", device_id: "B", timestamp: 1_000_000_100,
    });
    expect(onProgress).toHaveBeenCalledTimes(2);
  });

  it("same device updates in place; unknown doc gives {}", async () => {
    await create(app);
    await put(app, { document: "d1", progress: "1", percentage: 0.1, device: "Kobo", device_id: "A" });
    await put(app, { document: "d1", progress: "2", percentage: 0.2, device: "Kobo", device_id: "A" });
    const r = await app.request("/syncs/progress/d1", { headers: auth });
    expect((await r.json()).percentage).toBe(0.2);
    const none = await app.request("/syncs/progress/zzz", { headers: auth });
    expect(await none.json()).toEqual({});
  });

  it("rejects unauthenticated and malformed progress", async () => {
    await create(app);
    expect((await put(app, {}, { ...auth, "x-auth-key": "bad" })).status).toBe(401);
    expect((await put(app, { document: "d1" })).status).toBe(403);
    expect((await app.request("/syncs/progress/d1")).status).toBe(401);
  });

  it("passes CrossPoint-style metadata to the identify hook, with Basic auth alongside the x-auth headers", async () => {
    const onMetadata = vi.fn();
    const a = kosyncRoutes({ db: openDb(":memory:"), registrationDisabled: false, onMetadata });
    await create(a);
    const r = await put(
      a,
      { document: "d1", progress: "/body/DocFragment[2]/body", percentage: 0.3, device: "CrossPoint", device_id: "crosspoint-reader", metadata: { title: "Rebecca", authors: "Daphne du Maurier" } },
      { ...auth, Authorization: "Basic " + Buffer.from("nick:password").toString("base64") },
    );
    expect(r.status).toBe(200);
    expect(onMetadata).toHaveBeenCalledWith("d1", { title: "Rebecca", authors: "Daphne du Maurier" }, { id: "crosspoint-reader", name: "CrossPoint" });
  });
});
