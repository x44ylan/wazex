import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

// Every API response is fictional. Never use a real archive for public images.
const account = { id: "row:demo", name: "roadtrip_demo", region: "row" };
const end = Date.UTC(2026, 8, 30, 12);
const drives = Array.from({ length: 96 }, (_, i) => {
  const start = end - Math.floor(i / 2) * 86400000 - (i % 2) * 28800000;
  return {
    id: `trip-${String(i + 1).padStart(3, "0")}`,
    start,
    end: start + (12 + ((i * 7) % 45)) * 60000,
    meters: 1800 + ((i * 1771) % 28000),
    hasDetail: true,
  };
});
const roads = [
  [
    [0, 0],
    [8, 6],
    [17, 4],
    [27, 10],
    [34, 18],
    [45, 20],
    [53, 28],
    [65, 30],
    [74, 38],
    [88, 40],
  ],
  [
    [27, 10],
    [24, 20],
    [25, 32],
    [20, 42],
    [22, 54],
    [15, 65],
    [18, 76],
  ],
  [
    [18, 76],
    [9, 83],
    [5, 94],
    [12, 101],
    [24, 99],
    [28, 90],
    [18, 76],
  ],
  [
    [53, 28],
    [56, 39],
    [64, 48],
    [72, 50],
    [78, 57],
  ],
  [
    [65, 30],
    [65, 20],
    [72, 16],
    [77, 21],
    [74, 29],
    [65, 30],
  ],
  [
    [17, 4],
    [15, -5],
    [20, -12],
    [16, -18],
    [8, -22],
  ],
  [
    [24, 20],
    [13, 18],
    [5, 22],
    [-4, 18],
    [-10, 23],
  ],
  [
    [34, 18],
    [31, 25],
    [37, 30],
    [42, 25],
    [45, 20],
  ],
  [
    [0, 0],
    [-8, 6],
    [-15, 4],
    [-22, 10],
  ],
  [
    [22, 54],
    [32, 57],
    [43, 55],
    [49, 61],
  ],
];
const routes = drives.map((drive, i) => ({
  id: drive.id,
  start: drive.start,
  points: roads[i % roads.length].map(([x, y]) => [
    10 + x * 0.001,
    10 + y * 0.001,
  ]),
}));
const status = {
  token: "screenshot-fixture",
  publicOrigin: null,
  connected: account,
  connectionState: "connected",
  activeAccount: account.id,
  accounts: [account],
  region: "row",
  running: false,
  connecting: false,
  login: { state: "idle" },
  progress: null,
  lastError: null,
  lastSync: new Date(end).toISOString(),
  autoSync: true,
  syncHours: 168,
  recovery: null,
  runs: [],
};

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    timezoneId: "UTC",
  });
  await context.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    const data =
      path === "/api/status"
        ? status
        : path === "/api/drives"
          ? drives
          : path === "/api/routes"
            ? routes
            : { error: "Screenshot fixture only" };
    return route.fulfill({ json: data });
  });
  await context.addInitScript(() => {
    localStorage.setItem("wazex-theme", "light");
    localStorage.setItem("wazex-timezone", "UTC");
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("http://127.0.0.1:4310");
  await page.locator(".replay-network path").first().waitFor();
  await page.evaluate(() => document.fonts.ready);
  await mkdir("docs/images", { recursive: true });
  await page.screenshot({ path: "docs/images/overview.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".mobile-overview .replay-network").waitFor();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: "docs/images/overview-mobile.png" });
  if (errors.length) throw new Error(errors.join("\n"));
  console.log(
    "README images generated with fictional drives and roadtrip_demo; all API calls mocked.",
  );
} finally {
  await browser.close();
}
