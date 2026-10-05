import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionVault } from "../server/session-vault.js";
import { WazeClient } from "../server/waze-direct.js";

const json = (data, status = 200, cookies = []) => {
  const headers = new Headers({ "Content-Type": "application/json" });
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(JSON.stringify(data), { status, headers });
};
function fixture() {
  let state = "token_created",
    now = 1000;
  const calls = [],
    saved = [];
  const vault = {
    load: () => null,
    save: (data) => saved.push(data),
    clear: () => {},
  };
  const fetcher = async (url, options) => {
    assert.equal(options.headers.Accept, "application/json, text/plain, */*");
    const path = new URL(url).pathname;
    calls.push({ path, options });
    if (path === "/login/get")
      return json({ reply: { login: false } }, 200, [
        "_csrf_token=csrf-test; Path=/; Secure",
        "_web_session=guest; Path=/; Secure; HttpOnly",
      ]);
    if (options.method === "POST") {
      assert.equal(options.headers["X-CSRF-Token"], "csrf-test");
      assert.match(options.headers.Cookie, /_web_session=guest/);
      assert.equal(options.headers.Origin, "https://www.waze.com");
    }
    if (path.endsWith("/token")) return json({ token: "test-challenge" }, 201);
    if (path.endsWith("/lookup"))
      return state === "expired"
        ? json({}, 404)
        : json({ flowState: state }, 201);
    if (path.endsWith("/session"))
      return json({ id: 42 }, 200, [
        "_web_session=authenticated-test; Path=/; Secure; HttpOnly",
      ]);
    if (path.endsWith("/Session"))
      return json({ id: 42, userName: "Test user" });
    throw new Error(`Unexpected test path ${path}`);
  };
  const client = new WazeClient(vault, { fetcher, now: () => now });
  return {
    client,
    calls,
    saved,
    setState: (s) => {
      state = s;
    },
    advance: (ms) => {
      now += ms;
    },
  };
}

test("QR approval activates a verified account; pending challenge never replaces stored session", async () => {
  const f = fixture();
  const begin = await f.client.beginLogin("row");
  assert.match(begin.qrCode, /^data:image\/png;base64,/);
  const link = new URL(begin.loginUrl);
  assert.equal(link.origin, "https://www.waze.com");
  assert.equal(link.pathname, "/ul");
  assert.equal(link.searchParams.get("a"), "multidevice_authorization");
  const authorization = new URL(
    decodeURIComponent(link.searchParams.get("url_ex")),
  );
  assert.equal(
    authorization.pathname,
    "/_user/login/multidevice/authorization",
  );
  assert.ok(authorization.searchParams.get("token"));
  assert.equal(begin.state, "token_created");
  assert.equal(begin.token, undefined);
  assert.equal(f.saved.length, 0);
  f.setState("token_read");
  assert.equal((await f.client.pollLogin()).state, "token_read");
  f.advance(3000);
  f.setState("consent_granted");
  const result = await f.client.pollLogin();
  assert.equal(result.state, "connected");
  assert.equal(result.qrCode, undefined);
  assert.equal(result.loginUrl, undefined);
  assert.equal(result.account.userName, "Test user");
  assert.equal(f.saved.length, 1);
  assert.match(
    await f.client.jar.getCookieString("https://www.waze.com"),
    /authenticated-test/,
  );
  assert.ok(f.calls.some((c) => c.path.endsWith("/Session")));
});

test("expired QR challenges do not activate or persist a session", async () => {
  const f = fixture();
  await f.client.beginLogin("row");
  f.setState("expired");
  assert.equal((await f.client.pollLogin()).state, "expired");
  assert.equal(f.client.loginStatus().loginUrl, undefined);
  assert.equal(f.saved.length, 0);
  assert.equal(await f.client.jar.getCookieString("https://www.waze.com"), "");
  await f.client.beginLogin("row");
  f.advance(120001);
  assert.equal((await f.client.pollLogin()).state, "expired");
});

test("canceling an in-flight approval cannot restore a canceled session", async () => {
  const f = fixture();
  await f.client.beginLogin("row");
  let release;
  const original = f.client.fetcher;
  f.client.fetcher = async (url, options) => {
    if (new URL(url).pathname.endsWith("/lookup"))
      return new Promise((resolve) => {
        release = () => resolve(json({ flowState: "consent_granted" }));
      });
    return original(url, options);
  };
  const poll = f.client.pollLogin();
  while (!release) await new Promise((r) => setImmediate(r));
  f.client.cancelLogin();
  release();
  assert.equal((await poll).state, "idle");
  assert.equal(f.saved.length, 0);
  assert.equal(
    f.calls.some((c) => c.path.endsWith("/session")),
    false,
  );
});

test("vault encryption survives restart, detects tampering, and contains no plaintext cookie", () => {
  const directory = mkdtempSync(join(tmpdir(), "wazex-vault-test-"));
  try {
    const v = new SessionVault(directory);
    const data = {
      cookies: [{ key: "_web_session", value: "private-test-secret" }],
    };
    v.save(data);
    const encrypted = readFileSync(v.file, "utf8");
    assert.equal(encrypted.includes("private-test-secret"), false);
    assert.deepEqual(new SessionVault(directory).load(), data);
    const damaged = JSON.parse(encrypted);
    damaged.tag = Buffer.alloc(16).toString("base64");
    writeFileSync(v.file, JSON.stringify(damaged));
    assert.throws(() => v.load(), /could not be decrypted/);
    v.clear();
    assert.equal(v.load(), null);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("direct transport rejects foreign origins before sending cookies", async () => {
  const f = fixture();
  await assert.rejects(
    f.client.request("https://example.com/collect"),
    /Unsupported/,
  );
  assert.equal(f.calls.length, 0);
});
