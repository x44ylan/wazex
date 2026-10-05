import { CookieJar } from "tough-cookie";
import QRCode from "qrcode";
import { REGIONS } from "./sync.js";

const ORIGIN = "https://www.waze.com";
const LOGIN = "/_user/api/login/multidevice/token";
const authError = (message) =>
  Object.assign(new Error(message), { code: "AUTH_REQUIRED" });

export class WazeClient {
  constructor(vault, { fetcher = fetch, now = Date.now } = {}) {
    this.vault = vault;
    this.fetcher = fetcher;
    this.now = now;
    const saved = vault?.load();
    this.jar = saved ? CookieJar.fromJSON(saved) : new CookieJar();
    this.pending = null;
    this.generation = 0;
    this.polling = null;
  }
  async request(path, { jar = this.jar, body, params = {} } = {}) {
    const url = new URL(path, ORIGIN);
    if (url.origin !== ORIGIN) throw new Error("Unsupported Waze origin.");
    for (const [key, value] of Object.entries(params))
      url.searchParams.set(key, String(value));
    const cookies = await jar.getCookieString(url.href);
    const csrf = (await jar.getCookies(url.href)).find(
      (c) => c.key === "_csrf_token",
    )?.value;
    const response = await this.fetcher(url.href, {
      method: body === undefined ? "GET" : "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(30000),
      headers: {
        Accept: "application/json, text/plain, */*",
        Referer: `${ORIGIN}/signin`,
        ...(cookies ? { Cookie: cookies } : {}),
        ...(body !== undefined
          ? {
              "Content-Type": "application/json",
              Origin: ORIGIN,
              ...(csrf ? { "X-CSRF-Token": csrf } : {}),
            }
          : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const cookie of response.headers.getSetCookie())
      await jar.setCookie(cookie, url.href);
    const text = await response.text();
    if (jar === this.jar && this.vault) this.vault.save(await jar.serialize());
    if (
      response.status === 401 ||
      (response.status >= 300 &&
        response.status < 400 &&
        /signin|login/.test(response.headers.get("location") || ""))
    )
      throw authError("Your Waze session needs reconnecting.");
    if (!response.ok)
      throw Object.assign(
        new Error(`Waze returned HTTP ${response.status}. Please retry later.`),
        { status: response.status },
      );
    if (!(response.headers.get("content-type") || "").includes("json"))
      throw new Error("Waze returned an unexpected page. Please retry later.");
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("Waze returned an unreadable response.");
    }
  }
  async beginLogin(region) {
    if (!REGIONS[region]) throw new Error("Choose a supported Waze region.");
    const generation = ++this.generation;
    const jar = new CookieJar();
    await this.request("/login/get", { jar });
    const data = await this.request(LOGIN, { jar, body: {} });
    if (!data.token || typeof data.token !== "string")
      throw new Error("Waze's QR login format changed.");
    const authorization = new URL(
      `${ORIGIN}/_user/login/multidevice/authorization`,
    );
    authorization.searchParams.set("token", data.token);
    authorization.searchParams.set("source", "default");
    const link = new URL(`${ORIGIN}/ul`);
    link.searchParams.set("source", "default");
    link.searchParams.set("nl", "F");
    link.searchParams.set("url_ex", encodeURIComponent(authorization.href));
    link.searchParams.set("title_ex", "Approve Waze sign-in for wazex");
    link.searchParams.set("a", "multidevice_authorization");
    const qrCode = await QRCode.toDataURL(link.href, {
      width: 280,
      margin: 2,
      errorCorrectionLevel: "M",
      color: { dark: "#283449", light: "#ffffff" },
    });
    if (generation !== this.generation)
      throw new Error("Login was canceled. Start again when ready.");
    this.pending = {
      generation,
      jar,
      token: data.token,
      region,
      state: "token_created",
      qrCode,
      loginUrl: link.href,
      expiresAt: this.now() + 120000,
      lastPoll: 0,
    };
    return this.loginStatus();
  }
  loginStatus() {
    if (!this.pending) return { state: "idle" };
    const { state, qrCode, loginUrl, expiresAt, region, error, account } =
      this.pending;
    return {
      state,
      loginUrl: ["token_created", "token_read"].includes(state)
        ? loginUrl
        : undefined,
      qrCode: ["token_created", "token_read"].includes(state)
        ? qrCode
        : undefined,
      expiresAt,
      region,
      error,
      account,
    };
  }
  async pollLogin() {
    if (this.polling) return this.polling;
    this.polling = this.updateLogin();
    try {
      return await this.polling;
    } finally {
      this.polling = null;
    }
  }
  async updateLogin() {
    const pending = this.pending;
    if (!pending || !["token_created", "token_read"].includes(pending.state))
      return this.loginStatus();
    if (this.now() >= pending.expiresAt) {
      pending.state = "expired";
      return this.loginStatus();
    }
    if (pending.lastPoll && this.now() - pending.lastPoll < 3000)
      return this.loginStatus();
    pending.lastPoll = this.now();
    try {
      const data = await this.request(`${LOGIN}/lookup`, {
        jar: pending.jar,
        body: { id: pending.token },
      });
      if (pending.generation !== this.generation) return this.loginStatus();
      if (data.flowState === "consent_granted") {
        await this.request(`${LOGIN}/session`, {
          jar: pending.jar,
          body: { locale: "en", token: pending.token },
        });
        const user = await this.get(
          pending.region,
          "Session",
          { language: "en-US" },
          pending.jar,
        );
        if (!user.id || !user.userName)
          throw new Error(
            "Waze approval did not establish an editor session. Try signing in again.",
          );
        if (pending.generation !== this.generation) return this.loginStatus();
        if (this.vault) this.vault.save(await pending.jar.serialize());
        this.jar = pending.jar;
        pending.account = { id: user.id, userName: user.userName };
        pending.state = "connected";
      } else if (["token_created", "token_read"].includes(data.flowState))
        pending.state = data.flowState;
      else
        throw new Error(
          "Waze returned an unexpected QR approval state. Start a new code.",
        );
    } catch (error) {
      if (pending.generation !== this.generation) return this.loginStatus();
      if (error.status === 404) pending.state = "expired";
      else {
        pending.state = "error";
        pending.error = error.message;
      }
    }
    return this.loginStatus();
  }
  cancelLogin() {
    this.generation++;
    this.pending = null;
  }
  async get(region, path, params = {}, jar = this.jar) {
    if (!REGIONS[region]) throw new Error("Choose a supported Waze region.");
    return this.request(`/${REGIONS[region]}/app/${path}`, { params, jar });
  }
  async session(region) {
    const data = await this.get(region, "Session", { language: "en-US" });
    if (!data.id || !data.userName)
      throw authError("Connect your Waze account with the QR code first.");
    return { id: data.id, userName: data.userName };
  }
  async hasSession() {
    return (await this.jar.getCookies(ORIGIN)).some(
      (cookie) => cookie.key === "_web_session",
    );
  }
  async list(region, offset) {
    await new Promise((r) => setTimeout(r, 200));
    const data = await this.get(region, "Archive/List", {
      count: 15,
      minDistance: 0,
      offset,
      username: "",
    });
    if (!Array.isArray(data.archives?.objects))
      throw new Error("Waze drive list format changed.");
    return { rows: data.archives.objects, total: data.archives.totalSessions };
  }
  async detail(region, id) {
    await new Promise((r) => setTimeout(r, 200));
    return this.get(region, "Archive/SessionGPS", { id });
  }
  disconnect() {
    this.cancelLogin();
    this.jar = new CookieJar();
    this.vault?.clear();
  }
  async close() {
    this.cancelLogin();
  }
}
