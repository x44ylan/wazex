import React, { useState, useEffect, useRef } from "react";
import DriveReplay from "./DriveReplay.jsx";
import { createRoot } from "react-dom/client";
import {
  AreaChart,
  Area,
  ResponsiveContainer,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  BarChart,
  Bar,
} from "recharts";
import {
  ArrowUpRight,
  ArrowDownToLine,
  ArrowUpFromLine,
  RefreshCw,
  Route,
  Clock3,
  CalendarDays,
  ChevronRight,
  LayoutDashboard,
  Settings2,
  CarFront,
  X,
  LogOut,
  ExternalLink,
  Check,
  AlertCircle,
  LoaderCircle,
  MapPin,
  Database,
  Sparkles,
  Sun,
  Moon,
  Monitor,
} from "lucide-react";
import {
  analyze,
  dayKey,
  driveSeconds,
  routeCoordinates,
  demoDrives,
} from "./analytics.js";
import "./styles.css";

const regions = { row: "Rest of world", na: "North America", il: "Israel" };
const timezoneOptions = [
  ...new Set([
    Intl.DateTimeFormat().resolvedOptions().timeZone,
    "Asia/Singapore",
    "UTC",
    "America/New_York",
    "America/Los_Angeles",
    "Europe/London",
    "Asia/Jerusalem",
  ]),
];
const number = (n) =>
  new Intl.NumberFormat("en", { maximumFractionDigits: 1 }).format(n);
const duration = (s) => {
  if (!Number.isFinite(s) || s < 0) return "Unavailable";
  const m = Math.round(s / 60);
  return `${Math.floor(m / 60)}h ${m % 60}m`;
};
const compactDuration = (seconds) => {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const minutes = Math.round(seconds / 60);
  return minutes < 60
    ? `${minutes} min`
    : `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`;
};

function App() {
  const [theme, setTheme] = useState(() => {
    const saved = localStorage.getItem("wazex-theme");
    return ["light", "dark", "system"].includes(saved) ? saved : "system";
  });
  const [systemDark, setSystemDark] = useState(
    () => matchMedia("(prefers-color-scheme: dark)").matches,
  );
  useEffect(() => {
    const query = matchMedia("(prefers-color-scheme: dark)");
    const update = () => setSystemDark(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  const darkTheme = theme === "dark" || (theme === "system" && systemDark);
  useEffect(() => {
    document.documentElement.dataset.theme = darkTheme ? "dark" : "light";
    document.documentElement.style.colorScheme = darkTheme ? "dark" : "light";
    const suffix = darkTheme ? "-dark" : "";
    document
      .querySelector("#favicon")
      ?.setAttribute(
        "href",
        `/icon-${darkTheme ? "dark" : "light"}.svg?v=route1`,
      );
    document
      .querySelector("#favicon-fallback")
      ?.setAttribute("href", `/favicon${suffix}.ico?v=route1`);
    document
      .querySelector("#favicon-png")
      ?.setAttribute("href", `/favicon${suffix}.png?v=route1`);
    localStorage.setItem("wazex-theme", theme);
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", darkTheme ? "#111318" : "#fafafa");
  }, [theme, darkTheme]);
  const [mobile, setMobile] = useState(
    () => matchMedia("(max-width: 760px)").matches,
  );
  useEffect(() => {
    const query = matchMedia("(max-width: 760px)");
    const update = () => setMobile(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  const [view, setView] = useState("overview"),
    [status, setStatus] = useState(null),
    [drives, setDrives] = useState([]),
    [account, setAccount] = useState("");
  const [range, setRange] = useState("all"),
    [unit, setUnit] = useState(localStorage.getItem("wazex-unit") || "km"),
    [timezone, setTimezone] = useState(
      localStorage.getItem("wazex-timezone") ||
        Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
  const [demo, setDemo] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [detail, setDetail] = useState(null),
    [selectedRegion, setSelectedRegion] = useState("row");
  const [login, setLogin] = useState(null);
  const [networkError, setNetworkError] = useState("");
  const [search, setSearch] = useState(""),
    [page, setPage] = useState(0),
    [sort, setSort] = useState("newest");
  const importRef = useRef(),
    previousRun = useRef(false),
    statusRef = useRef(null),
    accountRef = useRef("");
  const loginRef = useRef(null);
  const previousSync = useRef(null);
  const factor = unit === "mi" ? 1609.344 : 1000;
  async function api(path, body) {
    let response;
    try {
      response = await fetch(
        `/api${path}`,
        body === undefined
          ? { signal: AbortSignal.timeout(10000) }
          : {
              method: "POST",
              signal: AbortSignal.timeout(10000),
              headers: {
                "Content-Type": "application/json",
                "X-Wazex-Token": statusRef.current?.token || "",
              },
              body: JSON.stringify(body),
            },
      );
    } catch {
      throw Object.assign(
        new Error(
          "The local wazex server is unavailable. Start it with npm run start:local. Retrying automatically.",
        ),
        { code: "SERVER_OFFLINE" },
      );
    }
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Request failed");
    return data;
  }
  async function refreshDrives(id = accountRef.current) {
    setDrives(
      await api(`/drives${id ? `?account=${encodeURIComponent(id)}` : ""}`),
    );
  }
  useEffect(() => {
    let disposed = false;
    let polling = false;
    async function poll() {
      if (polling) return;
      polling = true;
      try {
        const s = await api("/status");
        if (disposed) return;
        setNetworkError("");
        statusRef.current = s;
        setStatus(s);
        if (!accountRef.current && s.accounts.length) {
          accountRef.current =
            s.connected?.id || s.activeAccount || s.accounts[0].id;
          setAccount(accountRef.current);
          await refreshDrives(accountRef.current);
        }
        if (
          (previousRun.current && !s.running) ||
          (s.lastSync && s.lastSync !== previousSync.current)
        ) {
          await refreshDrives();
          if (s.lastError) setError(s.lastError);
          else {
            setError("");
            if (previousRun.current)
              setNotice(s.runs[0]?.error || "Archive updated.");
          }
        }
        previousRun.current = s.running;
        previousSync.current = s.lastSync;
        if (
          !loginRef.current &&
          ["token_created", "token_read"].includes(s.login?.state)
        ) {
          loginRef.current = s.login;
          setLogin(s.login);
        }
        if (["token_created", "token_read"].includes(loginRef.current?.state)) {
          const l = await api("/login/status", {});
          if (disposed) return;
          loginRef.current = l;
          setLogin(l);
          if (l.state === "connected") {
            accountRef.current = `${l.region}:${l.account.id}`;
            setAccount(accountRef.current);
            setDemo(false);
            await refreshDrives(accountRef.current);
            setNotice(
              "Waze connected. Your archive sync runs in the background.",
            );
          } else if (l.state === "error")
            setError(l.error || "Waze login failed. Request a new code.");
        }
      } catch (e) {
        if (!disposed) {
          if (e.code === "SERVER_OFFLINE") setNetworkError(e.message);
          else setError(e.message);
        }
      } finally {
        polling = false;
      }
    }
    poll();
    const timer = setInterval(poll, 2000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    localStorage.setItem("wazex-unit", unit);
  }, [unit]);
  useEffect(() => {
    localStorage.setItem("wazex-timezone", timezone);
  }, [timezone]);
  useEffect(() => {
    setPage(0);
  }, [range, search, sort, account, demo]);
  async function action(fn) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function connect() {
    const result = await api("/login", { region: selectedRegion });
    loginRef.current = result;
    setLogin(result);
    setView("settings");
    setNotice(
      "Tap the QR code on your phone, or scan it with your camera. Sync starts after Waze approval.",
    );
  }
  async function cancelLogin() {
    await api("/login/cancel", {});
    loginRef.current = null;
    setLogin(null);
    setNotice("");
  }
  async function checkConnection() {
    const a = await api("/connection", {});
    accountRef.current = a.id;
    setAccount(a.id);
    setDemo(false);
    setStatus((s) => ({ ...s, connected: a }));
    await refreshDrives(a.id);
    setNotice(`Connected as ${a.name}. Ready to sync.`);
  }
  async function beginSync() {
    setDemo(false);
    await api("/sync", {});
    previousRun.current = true;
    setStatus((s) => ({ ...s, running: true }));
  }
  const all = demo ? demoDrives() : drives;
  const cutoff = range === "all" ? 0 : Date.now() - Number(range) * 86400000;
  const filtered = all.filter((d) => d.start >= cutoff);
  const stats = analyze(filtered, timezone);
  const chart = stats.days.map((d) => ({
    ...d,
    distance: +(d.meters / factor).toFixed(1),
    label: new Date(`${d.date}T12:00:00Z`).toLocaleDateString("en", {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    }),
  }));
  const week = stats.weekdays;
  const active = status?.connected;
  const ConnectionTools = mobile ? "details" : "div";
  const canSync =
    active || ["checking", "unknown"].includes(status?.connectionState);
  const date = (time) =>
    new Intl.DateTimeFormat("en", {
      timeZone: timezone,
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(time);
  const time = (stamp) =>
    new Intl.DateTimeFormat("en", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
    }).format(stamp);
  const rows = filtered
    .filter((d) =>
      `${d.id} ${date(d.start)} ${dayKey(d.start, timezone)}`
        .toLowerCase()
        .includes(search.toLowerCase()),
    )
    .sort((a, b) =>
      sort === "longest"
        ? b.meters - a.meters
        : sort === "oldest"
          ? a.start - b.start
          : b.start - a.start,
    );
  const syncing = status?.running;
  const lastSync = status?.lastSync
    ? new Date(status.lastSync).toLocaleString("en", {
        timeZone: timezone,
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "Not synced yet";

  async function showDrive(d) {
    if (demo) {
      setDetail({ ...d, detail: null });
      return;
    }
    await action(async () =>
      setDetail(
        await api(
          `/drives/${encodeURIComponent(d.id)}?account=${encodeURIComponent(account)}`,
        ),
      ),
    );
  }
  async function importArchive(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    await action(async () => {
      if (file.size > 50 * 1024 * 1024)
        throw new Error("Backup must be under 50 MB.");
      const result = await api("/import", JSON.parse(await file.text()));
      setDemo(false);
      accountRef.current = result.account;
      setAccount(result.account);
      await refreshDrives(result.account);
      setNotice(
        `Imported ${result.added} new drives from ${result.seen} entries.`,
      );
    });
    event.target.value = "";
  }
  function downloadCSV() {
    const content = [
      "id,start,end,distance_meters,duration_seconds",
      ...filtered.map((d) =>
        [
          d.id,
          new Date(d.start).toISOString(),
          driveSeconds(d) === null ? "" : new Date(d.end).toISOString(),
          d.meters,
          driveSeconds(d) ?? "",
        ]
          .map((x) => `"${String(x).replaceAll('"', '""')}"`)
          .join(","),
      ),
    ].join("\n");
    const url = URL.createObjectURL(new Blob([content], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "wazex-drives.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="app-shell">
      <main>
        <header className="topbar">
          <a
            className="brand"
            href="#"
            onClick={(e) => {
              e.preventDefault();
              setView("overview");
            }}
          >
            waze<span className="brand-x">x</span>
          </a>
          <nav aria-label="Main navigation">
            {[
              ["overview", LayoutDashboard, "Overview"],
              ["drives", Route, "Drive archive"],
              ["settings", Settings2, "Connections & settings"],
            ].map(([id, Icon, label]) => (
              <button
                key={id}
                aria-label={label}
                aria-current={view === id ? "page" : undefined}
                className={view === id ? "nav-item selected" : "nav-item"}
                onClick={() => setView(id)}
              >
                <Icon size={19} />
                <span>
                  {id === "settings"
                    ? "Settings"
                    : id === "drives"
                      ? "Drives"
                      : label}
                </span>
                {id === "drives" && all.length > 0 && (
                  <small>{all.length}</small>
                )}
              </button>
            ))}
          </nav>
          <button
            className="primary header-sync"
            aria-label={
              syncing
                ? "Syncing drives"
                : canSync
                  ? "Sync drives"
                  : "Connect Waze"
            }
            title={
              syncing
                ? "Syncing drives"
                : canSync
                  ? "Sync drives"
                  : "Connect Waze"
            }
            disabled={
              busy ||
              syncing ||
              !status ||
              status.connectionState === "checking"
            }
            onClick={() =>
              action(
                canSync
                  ? beginSync
                  : async () => {
                      setView("settings");
                      await connect();
                    },
              )
            }
          >
            <RefreshCw size={17} className={syncing ? "spin" : ""} />
          </button>
        </header>
        <div className="content">
          <div className="page-heading">
            <div>
              <h1>
                {view === "overview"
                  ? "Overview"
                  : view === "drives"
                    ? "Drives"
                    : "Settings"}
              </h1>
            </div>
            {mobile && view !== "settings" && (
              <select
                className="mobile-period"
                aria-label="Time range"
                value={range}
                onChange={(event) => setRange(event.target.value)}
              >
                <option value="all">All time</option>
                <option value="90">90 days</option>
                <option value="30">30 days</option>
                <option value="7">7 days</option>
              </select>
            )}
          </div>
          {networkError && (
            <div className="alert error" role="alert">
              <AlertCircle size={18} />
              <span>{networkError}</span>
            </div>
          )}
          {error && (
            <div className="alert error" role="alert">
              <AlertCircle size={18} />
              <span>{error}</span>
              <button aria-label="Dismiss error" onClick={() => setError("")}>
                <X size={16} />
              </button>
            </div>
          )}
          {notice && (
            <div className="alert success" role="status">
              <Check size={18} />
              <span>{notice}</span>
              <button
                aria-label="Dismiss message"
                onClick={() => setNotice("")}
              >
                <X size={16} />
              </button>
            </div>
          )}
          {status?.lastError && !error && (
            <div className="alert error">
              <AlertCircle size={18} />
              <span>Last sync: {status.lastError}</span>
            </div>
          )}
          {syncing && (
            <div className="alert progress">
              <LoaderCircle size={18} className="spin" />
              <span>
                {status.progress?.phase === "routes"
                  ? `Checking routes · ${status.progress.processed ?? status.progress.fetched} of ${status.progress.total}`
                  : `Archiving drives · ${status.progress?.seen || 0} found, ${status.progress?.added || 0} new`}
              </span>
            </div>
          )}
          {demo && (
            <div className="demo-banner">
              <Sparkles size={16} />
              <span>
                You’re exploring sample data. Your real archive is separate.
              </span>
              <button onClick={() => setDemo(false)}>
                Exit demo <X size={14} />
              </button>
            </div>
          )}
          {view !== "settings" && (
            <div className="filterbar">
              <div className="segment">
                {[
                  ["all", "All time"],
                  ["90", "90 days"],
                  ["30", "30 days"],
                  ["7", "7 days"],
                ].map(([key, label]) => (
                  <button
                    key={key}
                    onClick={() => setRange(key)}
                    className={range === key ? "active" : ""}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="filter-right">
                <span>
                  <RefreshCw size={13} /> Last synced {lastSync}
                </span>
              </div>
            </div>
          )}
          {view === "overview" &&
            (mobile ? (
              <MobileOverview
                stats={stats}
                chart={chart}
                drives={filtered}
                factor={factor}
                unit={unit}
                date={date}
                time={time}
                onDrive={showDrive}
                onAll={() => setView("drives")}
                timezone={timezone}
                replay={
                  <DriveReplay
                    account={account}
                    drives={filtered}
                    revision={drives
                      .filter((d) => d.hasDetail)
                      .map((d) => d.id)
                      .join("|")}
                    demo={demo}
                  />
                }
              />
            ) : (
              <>
                <div className="stat-grid">
                  {[
                    [
                      Route,
                      "Distance travelled",
                      `${number(stats.meters / factor)}`,
                      unit,
                      "Total archived distance",
                      "blue",
                    ],
                    [
                      Clock3,
                      "Time on the road",
                      `${Math.floor(stats.seconds / 3600)}`,
                      "hours",
                      `${Math.round((stats.seconds % 3600) / 60)} additional minutes`,
                      "purple",
                    ],
                    [
                      CarFront,
                      "Drives taken",
                      `${stats.count}`,
                      "drives",
                      `${stats.activeDays} active days`,
                      "orange",
                    ],
                    [
                      CalendarDays,
                      "Average drive",
                      `${number(stats.averageMeters / factor)}`,
                      unit,
                      null,
                      "green",
                    ],
                  ].map(([Icon, label, value, suffix, sub, tone]) => (
                    <section className="stat-card" key={label}>
                      <div className="stat-title">
                        <span>{label}</span>
                        <span className={`stat-icon ${tone}`}>
                          <Icon size={18} />
                        </span>
                      </div>
                      <div className="stat-value">
                        {value}
                        <small>{suffix}</small>
                      </div>
                      {sub && <p>{sub}</p>}
                    </section>
                  ))}
                </div>
                {stats.incomplete > 0 && (
                  <p className="fine-print">
                    Waze omitted the end time for {stats.incomplete} archived
                    records. Their distances are included; duration and pace use
                    records with known end times.
                  </p>
                )}
                <div className="chart-grid">
                  <section className="panel distance-panel">
                    <div className="panel-heading">
                      <div>
                        <h2>Daily distance</h2>
                        <p>Distance travelled each day</p>
                      </div>
                      <span className="chart-key">
                        <i />
                        {unit === "mi" ? "Miles" : "Kilometers"}
                      </span>
                    </div>
                    <div className="area-chart">
                      {chart.length ? (
                        <ResponsiveContainer width="100%" height="100%">
                          <AreaChart
                            data={chart}
                            margin={{ top: 16, right: 8, left: -20, bottom: 0 }}
                          >
                            <defs>
                              <linearGradient
                                id="blueFill"
                                x1="0"
                                y1="0"
                                x2="0"
                                y2="1"
                              >
                                <stop
                                  offset="0%"
                                  stopColor="var(--blue)"
                                  stopOpacity={0.24}
                                />
                                <stop
                                  offset="100%"
                                  stopColor="var(--blue)"
                                  stopOpacity={0}
                                />
                              </linearGradient>
                            </defs>
                            <CartesianGrid
                              strokeDasharray="4 5"
                              vertical={false}
                              stroke="var(--line)"
                            />
                            <XAxis
                              dataKey="label"
                              axisLine={false}
                              tickLine={false}
                              minTickGap={45}
                              tick={{ fontSize: 11, fill: "var(--muted)" }}
                            />
                            <YAxis
                              domain={[0, "auto"]}
                              axisLine={false}
                              tickLine={false}
                              tick={{ fontSize: 11, fill: "var(--muted)" }}
                            />
                            <Tooltip
                              contentStyle={{
                                border: "1px solid var(--line)",
                                background: "var(--surface)",
                                color: "var(--text)",
                                borderRadius: 12,
                                fontSize: 12,
                              }}
                              formatter={(v) => [`${v} ${unit}`, "Distance"]}
                            />
                            <Area
                              isAnimationActive={false}
                              type="monotone"
                              dataKey="distance"
                              stroke="var(--blue)"
                              strokeWidth={2.5}
                              fill="url(#blueFill)"
                            />
                          </AreaChart>
                        </ResponsiveContainer>
                      ) : (
                        <EmptyChart onDemo={() => setDemo(true)} />
                      )}
                    </div>
                  </section>
                  <section className="panel weekly-panel">
                    <div className="panel-heading">
                      <div>
                        <h2>By weekday</h2>
                        <p>When you tend to hit the road</p>
                      </div>
                      <CalendarDays size={18} color="#8c97a8" />
                    </div>
                    <div className="weekly-chart">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart
                          data={week}
                          margin={{ top: 22, right: 0, left: 0, bottom: 0 }}
                        >
                          <XAxis
                            dataKey="name"
                            axisLine={false}
                            tickLine={false}
                            tick={{ fontSize: 11, fill: "var(--muted)" }}
                          />
                          <YAxis hide />
                          <Tooltip
                            cursor={{ fill: "var(--hover)" }}
                            contentStyle={{
                              borderRadius: 12,
                              border: "1px solid var(--line)",
                              background: "var(--surface)",
                              color: "var(--text)",
                              fontSize: 12,
                            }}
                          />
                          <Bar
                            isAnimationActive={false}
                            dataKey="count"
                            name="Drives"
                            fill="#7db6fa"
                            radius={[5, 5, 3, 3]}
                            maxBarSize={27}
                          />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                    <div className="weekly-insight">
                      <span className="stat-icon blue">
                        <Clock3 size={17} />
                      </span>
                      <div>
                        <strong>
                          {stats.count
                            ? `Peak departure: ${String(stats.busiestHour).padStart(2, "0")}:00`
                            : "Find your driving rhythm"}
                        </strong>
                        <p>
                          {stats.count
                            ? "Your most common hour to start a drive."
                            : "Your patterns will appear after your first sync."}
                        </p>
                      </div>
                    </div>
                  </section>
                </div>
                <DriveReplay
                  account={account}
                  drives={filtered}
                  revision={drives
                    .filter((d) => d.hasDetail)
                    .map((d) => d.id)
                    .join("|")}
                  demo={demo}
                />
                <section className="panel activity-panel">
                  <div className="panel-heading">
                    <div>
                      <h2>Activity</h2>
                      <p>Drives per day</p>
                    </div>
                    <div className="heat-legend">
                      Less{" "}
                      {[0, 1, 2, 3, 4].map((v) => (
                        <i key={v} className={`heat level-${v}`} />
                      ))}{" "}
                      More
                    </div>
                  </div>
                  <Heatmap drives={all} timezone={timezone} />
                </section>
                <div className="bottom-grid">
                  <section className="panel">
                    <div className="panel-heading">
                      <div>
                        <h2>Recent drives</h2>
                        <p>Latest archived records</p>
                      </div>
                      <button
                        className="text-link"
                        onClick={() => setView("drives")}
                      >
                        View all <ArrowUpRight size={15} />
                      </button>
                    </div>
                    {filtered.length ? (
                      <DriveTable
                        drives={filtered.slice(0, 5)}
                        date={date}
                        time={time}
                        factor={factor}
                        unit={unit}
                        onDrive={showDrive}
                      />
                    ) : (
                      <div className="empty-recent">
                        <CarFront size={26} />
                        <p>
                          Your next drive is the beginning of a great archive.
                        </p>
                        <button
                          className="text-link"
                          onClick={() => setView("settings")}
                        >
                          Connect your Waze account <ArrowUpRight size={15} />
                        </button>
                      </div>
                    )}
                  </section>
                  <section className="longest-card">
                    <div className="eyebrow">LONGEST DRIVE</div>
                    <Route size={34} />
                    <h2>
                      {stats.longest
                        ? `${number(stats.longest.meters / factor)} ${unit}`
                        : "A road worth remembering."}
                    </h2>
                    <p>
                      {stats.longest
                        ? `Your longest archived drive · ${date(stats.longest.start)}`
                        : "Sync your drives to discover your longest journey and the moments that stand out."}
                    </p>
                    {stats.longest && (
                      <button onClick={() => showDrive(stats.longest)}>
                        Explore this drive <ArrowUpRight size={16} />
                      </button>
                    )}
                    <span className="road-decoration" />
                  </section>
                </div>
              </>
            ))}
          {view === "drives" && (
            <section className="panel">
              <div className="archive-toolbar">
                <div>
                  <h2>All your drives</h2>
                  <p>{rows.length} matching journeys</p>
                </div>
                <input
                  placeholder="Search date or drive ID…"
                  aria-label="Search drives"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                <select
                  aria-label="Sort drives"
                  value={sort}
                  onChange={(e) => setSort(e.target.value)}
                >
                  <option value="newest">Newest first</option>
                  <option value="oldest">Oldest first</option>
                  <option value="longest">Longest first</option>
                </select>
                <button
                  className="secondary"
                  disabled={!filtered.length}
                  onClick={downloadCSV}
                >
                  <ArrowDownToLine size={15} /> CSV
                </button>
              </div>
              <DriveTable
                mobile={mobile}
                drives={rows.slice(page * 20, page * 20 + 20)}
                date={date}
                time={time}
                factor={factor}
                unit={unit}
                onDrive={showDrive}
              />
              {!rows.length && (
                <div className="empty-recent">No drives match this view.</div>
              )}
              <div className="pagination">
                <span>
                  {rows.length
                    ? `${page * 20 + 1}–${Math.min((page + 1) * 20, rows.length)} of ${rows.length}`
                    : "0 drives"}
                </span>
                <button
                  className="secondary"
                  disabled={!page}
                  onClick={() => setPage((p) => p - 1)}
                >
                  Previous
                </button>
                <button
                  className="secondary"
                  disabled={(page + 1) * 20 >= rows.length}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </button>
              </div>
            </section>
          )}
          {view === "settings" && (
            <div
              className={
                mobile ? "settings-grid mobile-settings" : "settings-grid"
              }
            >
              <section className="panel settings-panel">
                <div className="panel-heading">
                  <div>
                    <h2>Waze</h2>
                    <span className="account-name">
                      {active?.name || "Not connected"}
                    </span>
                  </div>
                  <span className="stat-icon blue">
                    <Route size={20} />
                  </span>
                </div>
                <ConnectionTools
                  className="connection-tools"
                  {...(mobile ? { open: !active || !!login } : {})}
                >
                  {mobile && (
                    <summary>
                      {active ? "Manage connection" : "Connect Waze"}
                      <ChevronRight size={15} aria-hidden="true" />
                    </summary>
                  )}
                  <label>
                    Waze editor region
                    <select
                      value={selectedRegion}
                      onChange={(e) => setSelectedRegion(e.target.value)}
                    >
                      {Object.entries(regions).map(([k, v]) => (
                        <option key={k} value={k}>
                          {v}
                        </option>
                      ))}
                    </select>
                  </label>
                  <p className="setting-description">
                    Approve sign-in in Waze on your phone.
                  </p>
                  <div className="button-row">
                    <button
                      className="primary"
                      disabled={busy || syncing}
                      onClick={() => action(connect)}
                    >
                      <ExternalLink size={16} />
                      {active ? "Reconnect Waze" : "Get Waze QR code"}
                    </button>
                    <button
                      className="secondary"
                      disabled={busy || syncing}
                      onClick={() => action(checkConnection)}
                    >
                      <Check size={16} />
                      Check saved session
                    </button>
                  </div>
                  {login && (
                    <div className="qr-login" aria-live="polite">
                      {login.qrCode && (
                        <a
                          className="qr-open"
                          href={login.loginUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          aria-label="Open Waze to approve sign-in"
                        >
                          <img
                            src={login.qrCode}
                            width="240"
                            height="240"
                            alt="Waze sign-in QR code. Scan with your phone to approve wazex."
                          />
                          <span>
                            Open in Waze{" "}
                            <ExternalLink size={14} aria-hidden="true" />
                          </span>
                        </a>
                      )}
                      <strong>
                        {login.state === "token_created"
                          ? "Tap the code or scan with your camera"
                          : login.state === "token_read"
                            ? "Approve the connection on your phone"
                            : login.state === "connected"
                              ? "Waze connected"
                              : login.state === "expired"
                                ? "This code has expired"
                                : "Could not complete sign-in"}
                      </strong>
                      <p>
                        {["token_created", "token_read"].includes(login.state)
                          ? "Follow Waze’s instructions on your phone. This code lasts up to two minutes; Waze may expire it sooner."
                          : login.state === "connected"
                            ? "Your drives are being archived automatically."
                            : login.error ||
                              "Request a new QR code to try again."}
                      </p>
                      <div className="button-row">
                        {["expired", "error"].includes(login.state) && (
                          <button
                            className="secondary"
                            disabled={busy}
                            onClick={() => action(connect)}
                          >
                            <RefreshCw size={15} />
                            New QR code
                          </button>
                        )}
                        <button
                          className="text-link"
                          disabled={busy}
                          onClick={() => action(cancelLogin)}
                        >
                          {login.state === "connected"
                            ? "Dismiss"
                            : "Cancel sign-in"}
                        </button>
                      </div>
                    </div>
                  )}
                  {active && (
                    <div className="connected-account">
                      <Check size={17} />
                      <span>
                        Connected as <strong>{active.name}</strong> ·{" "}
                        {regions[active.region]}
                      </span>
                      <button
                        aria-label="Disconnect Waze"
                        onClick={() =>
                          action(async () => {
                            await api("/disconnect", {});
                            loginRef.current = null;
                            setLogin(null);
                            setStatus((s) => ({
                              ...s,
                              connected: null,
                              autoSync: false,
                            }));
                            setNotice(
                              "Disconnected. Your saved drives remain in the archive.",
                            );
                          })
                        }
                        disabled={syncing || busy}
                      >
                        <LogOut size={16} />
                      </button>
                    </div>
                  )}
                </ConnectionTools>
                <div className="setting-divider" />
                <label className="toggle-setting">
                  <div>
                    <strong>Weekly sync</strong>
                  </div>
                  <input
                    type="checkbox"
                    role="switch"
                    aria-label="Automatic sync"
                    checked={status?.autoSync || false}
                    disabled={busy || !status}
                    onChange={(e) => {
                      const enabled = e.target.checked;
                      const previous = status?.autoSync || false;
                      setStatus((s) => ({ ...s, autoSync: enabled }));
                      action(async () => {
                        try {
                          await api("/settings", { autoSync: enabled });
                          setStatus((s) => ({ ...s, autoSync: enabled }));
                        } catch (error) {
                          setStatus((s) => ({ ...s, autoSync: previous }));
                          throw error;
                        }
                      });
                    }}
                  />
                </label>
              </section>
              <section className="panel settings-panel">
                <div className="panel-heading">
                  <div>
                    <h2>Preferences</h2>
                  </div>
                  <Database size={20} color="#3293f7" />
                </div>
                <div className="theme-setting">
                  <span id="appearance-label">Appearance</span>
                  <div
                    className="theme-options"
                    role="group"
                    aria-labelledby="appearance-label"
                  >
                    {[
                      ["light", "Light", Sun],
                      ["dark", "Dark", Moon],
                      ["system", "System", Monitor],
                    ].map(([value, label, Icon]) => (
                      <button
                        key={value}
                        type="button"
                        aria-pressed={theme === value}
                        onClick={() => setTheme(value)}
                      >
                        <Icon size={16} aria-hidden="true" />
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
                <label>
                  Distance units
                  <select
                    value={unit}
                    onChange={(e) => setUnit(e.target.value)}
                  >
                    <option value="km">Kilometers</option>
                    <option value="mi">Miles</option>
                  </select>
                </label>
                <label>
                  Display timezone
                  <select
                    value={timezone}
                    onChange={(e) => setTimezone(e.target.value)}
                  >
                    {timezoneOptions.map((t) => (
                      <option value={t} key={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </label>
                <h3 className="backup-heading">Backup</h3>
                <div className="button-row backup-actions">
                  <a
                    className={`secondary ${!account ? "disabled" : ""}`}
                    aria-label="Export backup"
                    href={`/api/export?account=${encodeURIComponent(account)}`}
                    onClick={(e) => {
                      if (!account) e.preventDefault();
                    }}
                  >
                    <ArrowDownToLine size={16} />
                    Export
                  </a>
                  <button
                    className="secondary"
                    aria-label="Restore backup"
                    disabled={busy || syncing}
                    onClick={() => importRef.current.click()}
                  >
                    <ArrowUpFromLine size={16} />
                    Restore
                  </button>
                  <input
                    ref={importRef}
                    type="file"
                    accept=".json,application/json"
                    hidden
                    onChange={importArchive}
                  />
                </div>
              </section>
              <details className="panel sync-log">
                <summary className="panel-heading">
                  <div>
                    <h2>Sync history</h2>
                    <p>
                      {status?.recovery && status?.autoSync
                        ? `Recovery scheduled for ${new Date(status.recovery.nextAt).toLocaleTimeString("en", { timeZone: timezone, hour: "numeric", minute: "2-digit" })}. Saved drives remain available.`
                        : "What was saved, and when."}
                    </p>
                  </div>
                  <ChevronRight size={16} />
                </summary>
                {status?.runs.length ? (
                  status.runs.map((r) => (
                    <div className="sync-run" key={r.id}>
                      <span className={`run-badge ${r.status}`}>
                        {r.status}
                      </span>
                      <div>
                        <strong>
                          {new Date(r.started).toLocaleString("en", {
                            timeZone: timezone,
                          })}
                        </strong>
                        <p>
                          {r.seen} drives checked · {r.added} newly archived
                          {r.error && ` · ${r.error}`}
                        </p>
                      </div>
                    </div>
                  ))
                ) : (
                  <p className="setting-description">
                    Your first sync will appear here.
                  </p>
                )}
              </details>
            </div>
          )}
          <footer>Stored on this device</footer>
        </div>
      </main>
      {detail && (
        <div className="modal-backdrop" onClick={() => setDetail(null)}>
          <section
            className="drive-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Drive details"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="modal-close"
              aria-label="Close drive details"
              onClick={() => setDetail(null)}
            >
              <X size={20} />
            </button>
            <div className="eyebrow">A DRIVE TO REMEMBER</div>
            <h2>{date(detail.start)}</h2>
            <p>
              {time(detail.start)} →{" "}
              {driveSeconds(detail) === null
                ? "End time unavailable"
                : time(detail.end)}{" "}
              · {timezone}
            </p>
            <div className="detail-stats">
              <div>
                <strong>
                  {number(detail.meters / factor)} <small>{unit}</small>
                </strong>
                <span>Distance</span>
              </div>
              <div>
                <strong>{duration(driveSeconds(detail))}</strong>
                <span>Duration</span>
              </div>
              <div>
                <strong>
                  {!(driveSeconds(detail) > 0)
                    ? "Unavailable"
                    : number(
                        (detail.meters / driveSeconds(detail)) *
                          3.6 *
                          (unit === "mi" ? 0.621371 : 1),
                      )}
                  {driveSeconds(detail) > 0 && <small> {unit}/h</small>}
                </strong>
                <span>Trip speed · includes stops</span>
              </div>
            </div>
            <RoutePreview detail={detail.detail} />
            <p className="fine-print">Drive ID: {detail.id}</p>
          </section>
        </div>
      )}
    </div>
  );
}

function MobileOverview({
  replay,
  stats,
  chart,
  drives,
  factor,
  unit,
  date,
  time,
  onDrive,
  onAll,
  timezone,
}) {
  return (
    <div className="mobile-overview">
      <section className="mobile-summary">
        <div className="mobile-distance">
          {number(stats.meters / factor)} <small>{unit}</small>
        </div>
        <div className="mobile-metrics">
          <div>
            <strong>{compactDuration(stats.seconds)}</strong>
            <span>Driving</span>
          </div>
          <div>
            <strong>{stats.count}</strong>
            <span>Drives</span>
          </div>
        </div>
        {stats.incomplete > 0 && (
          <p className="fine-print">
            {stats.incomplete} records have no duration.
          </p>
        )}
      </section>
      <section className="mobile-chart">
        <h2>Daily distance</h2>
        {chart.length > 0 ? (
          <div style={{ height: 130 }}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart
                data={chart}
                margin={{ top: 16, right: 2, left: 2, bottom: 0 }}
              >
                <XAxis
                  dataKey="label"
                  axisLine={false}
                  tickLine={false}
                  minTickGap={65}
                  tick={{ fontSize: 10, fill: "var(--muted)" }}
                />
                <YAxis domain={[0, "auto"]} hide />
                <Tooltip
                  contentStyle={{
                    background: "var(--surface)",
                    border: "1px solid var(--line)",
                    color: "var(--text)",
                    borderRadius: 10,
                  }}
                  formatter={(v) => [`${v} ${unit}`, "Distance"]}
                />
                <Area
                  dataKey="distance"
                  type="monotone"
                  stroke="var(--blue)"
                  fill="var(--chart-fill)"
                  strokeWidth={2}
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <p className="fine-print">Sync Waze to see your driving history.</p>
        )}
      </section>
      {replay}
      <section>
        <div className="mobile-section-heading">
          <h2>Recent drives</h2>
          <button className="text-link" onClick={onAll}>
            View all
          </button>
        </div>
        <DriveTable
          mobile
          drives={drives.slice(0, 3)}
          date={date}
          time={time}
          factor={factor}
          unit={unit}
          onDrive={onDrive}
        />
        {!drives.length && (
          <p className="fine-print">No drives in this period.</p>
        )}
      </section>
      <details className="mobile-insights">
        <summary>More insights</summary>
        <div className="mobile-insight-row">
          <span>Longest drive</span>
          <strong>
            {number((stats.longest?.meters || 0) / factor)} {unit}
          </strong>
        </div>
        <div className="mobile-insight-row">
          <span>Active days</span>
          <strong>{stats.activeDays}</strong>
        </div>
        <div className="mobile-insight-row">
          <span>Busiest departure hour</span>
          <strong>
            {stats.count
              ? `${String(stats.busiestHour).padStart(2, "0")}:00`
              : "—"}
          </strong>
        </div>
        <Heatmap drives={drives} timezone={timezone} />
      </details>
    </div>
  );
}

function DriveTable({
  drives,
  date,
  time,
  factor,
  unit,
  onDrive,
  mobile = false,
}) {
  if (mobile)
    return (
      <div className="mobile-drive-list">
        {drives.map((d, index) => (
          <React.Fragment key={d.id}>
            {(index === 0 ||
              date(d.start) !== date(drives[index - 1].start)) && (
              <div className="mobile-drive-day">{date(d.start)}</div>
            )}
            <button
              className="mobile-drive"
              onClick={() => onDrive(d)}
              aria-label={`View drive ${d.id}`}
            >
              <span>
                <strong>{time(d.start)}</strong>
                <small>{compactDuration(driveSeconds(d))}</small>
              </span>
              <span className="mobile-drive-distance">
                <strong>
                  {number(d.meters / factor)} <small>{unit}</small>
                </strong>
              </span>
            </button>
          </React.Fragment>
        ))}
      </div>
    );
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Journey</th>
            <th>Departure</th>
            <th>Distance</th>
            <th>Duration</th>
            <th>Route</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {drives.map((d) => (
            <tr key={d.id} onClick={() => onDrive(d)}>
              <td>
                <div className="journey-cell">
                  <span>
                    <CarFront size={17} />
                  </span>
                  <div>
                    <strong>{date(d.start)}</strong>
                    <small>Drive · {d.id.slice(0, 8)}</small>
                  </div>
                </div>
              </td>
              <td>{time(d.start)}</td>
              <td>
                <strong>{number(d.meters / factor)}</strong> {unit}
              </td>
              <td>{duration(driveSeconds(d))}</td>
              <td>
                <span className={`route-badge ${d.hasDetail ? "saved" : ""}`}>
                  {d.hasDetail ? "Saved" : "Summary"}
                </span>
              </td>
              <td>
                <button
                  className="row-button"
                  aria-label={`View drive ${d.id}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onDrive(d);
                  }}
                >
                  <ChevronRight size={16} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function EmptyChart({ onDemo }) {
  return (
    <div className="empty-chart">
      <span className="empty-chart-icon">
        <Route size={28} />
      </span>
      <strong>Your journey starts here.</strong>
      <p>Connect Waze to bring your drives into focus.</p>
      <button className="text-link" onClick={onDemo}>
        Preview with sample data <ArrowUpRight size={14} />
      </button>
    </div>
  );
}
function Heatmap({ drives, timezone }) {
  const todayKey = dayKey(Date.now(), timezone),
    today = new Date(`${todayKey}T12:00:00Z`),
    counts = new Map();
  for (const d of drives) {
    const key = dayKey(d.start, timezone);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const start = new Date(today);
  start.setUTCDate(start.getUTCDate() - 364 - ((start.getUTCDay() + 6) % 7));
  const days = [];
  for (let i = 0; i < 371; i++) {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    const key = d.toISOString().slice(0, 10);
    const count = counts.get(key) || 0;
    days.push({ key, count, future: d > today });
  }
  const months = [];
  for (let col = 0; col < 53; col++) {
    const key = days[col * 7].key;
    const month = key.slice(0, 7);
    if (col === 0 || month !== days[(col - 1) * 7].key.slice(0, 7))
      months.push({
        col,
        label: new Date(`${key}T12:00:00Z`).toLocaleDateString("en", {
          month: "short",
          timeZone: "UTC",
        }),
      });
  }
  return (
    <div className="heatmap-scroll">
      <div className="heatmap-months">
        {months.map((m) => (
          <span key={m.col} style={{ gridColumn: m.col + 1 }}>
            {m.label}
          </span>
        ))}
      </div>
      <div className="heatmap-body">
        <div className="heatmap-labels">
          <span>Mon</span>
          <span>Wed</span>
          <span>Fri</span>
        </div>
        <div className="heatmap-grid">
          {days.map((d) => (
            <div
              key={d.key}
              title={`${d.key}: ${d.count} drives`}
              className={`heat level-${Math.min(d.count, 4)} ${d.future ? "future" : ""}`}
            />
          ))}
        </div>
      </div>
      <div className="heatmap-summary">
        <span>
          {
            drives.filter((d) => dayKey(d.start, timezone) >= days[0].key)
              .length
          }{" "}
          archived drives in the past year
        </span>
        <span>Every journey counts.</span>
      </div>
    </div>
  );
}
function RoutePreview({ detail }) {
  const points = routeCoordinates(detail);
  if (!points.length)
    return (
      <div className="route-empty">
        <MapPin size={27} />
        <strong>
          {detail ? "Route payload archived" : "No route geometry saved yet"}
        </strong>
        <p>
          {detail
            ? "This route format is stored in your backup but cannot be drawn yet."
            : "Sync again to fetch available route details. Some older drives only have a summary."}
        </p>
      </div>
    );
  const xs = points.map((p) => p[0]),
    ys = points.map((p) => p[1]),
    minX = Math.min(...xs),
    maxX = Math.max(...xs),
    minY = Math.min(...ys),
    maxY = Math.max(...ys);
  const ratio = Math.cos((((minY + maxY) / 2) * Math.PI) / 180),
    width = (maxX - minX) * ratio,
    height = maxY - minY,
    scale = Math.min(
      520 / Math.max(width, 0.000001),
      240 / Math.max(height, 0.000001),
    );
  const coords = points.map(([x, y]) => [
    40 + (520 - width * scale) / 2 + (x - minX) * ratio * scale,
    30 + (240 - height * scale) / 2 + (maxY - y) * scale,
  ]);
  return (
    <div className="route-preview">
      <span>
        <MapPin size={14} /> Your recorded route · {points.length} points
      </span>
      <svg viewBox="0 0 600 300" aria-label="Recorded drive route">
        <defs>
          <pattern
            id="grid"
            width="30"
            height="30"
            patternUnits="userSpaceOnUse"
          >
            <path d="M 30 0 L 0 0 0 30" fill="none" stroke="var(--line)" />
          </pattern>
        </defs>
        <rect width="600" height="300" fill="url(#grid)" />
        <polyline
          points={coords.map((p) => p.join(",")).join(" ")}
          fill="none"
          stroke="var(--blue)"
          strokeWidth="3"
          strokeLinejoin="round"
        />
        <circle
          cx={coords[0][0]}
          cy={coords[0][1]}
          r="6"
          fill="#fff"
          stroke="var(--blue)"
          strokeWidth="3"
        />
        <circle
          cx={coords.at(-1)[0]}
          cy={coords.at(-1)[1]}
          r="6"
          fill="#23ae88"
          stroke="#fff"
          strokeWidth="2"
        />
      </svg>
      <small>
        Route shape · No map tiles or location data sent to third parties
      </small>
    </div>
  );
}
createRoot(document.getElementById("root")).render(<App />);
