import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

// Failure cases: missing production assets, stale theme URLs, OS/app mismatch,
// reload/system changes, dark saved touch artwork, lost alpha/padding, missing
// ICO sizes, changed header branding, or a fixture using real archive state.
// This checks the production HTTP server and browser, not native iPhone caches.
const root = fileURLToPath(new URL("..", import.meta.url));
const artifact = join(root, "test-results/icons");
await mkdir(artifact, { recursive: true });
const state = await mkdtemp(join(tmpdir(), "wazex-icons-"));
const listener = createServer();
await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ["server/index.js"], {
  cwd: root,
  env: { ...process.env, PORT: String(port), WAZEX_DATA_DIR: state },
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
server.stdout.on("data", (chunk) => (logs += chunk));
server.stderr.on("data", (chunk) => (logs += chunk));
let browser;
const checks = [];
const errors = [];
const files = [
  "icon.svg",
  "icon-light.svg",
  "icon-dark.svg",
  "favicon.png",
  "favicon-dark.png",
  "favicon.ico",
  "favicon-dark.ico",
  "apple-touch-icon.png",
  "apple-touch-icon-precomposed.png",
];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function pixels(page, href) {
  return page.evaluate(async (path) => {
    const image = new Image();
    image.src = path;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(image, 0, 0);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0,
      total = 0,
      minX = canvas.width,
      minY = canvas.height,
      maxX = 0,
      maxY = 0;
    for (let i = 0; i < data.length; i += 4)
      if (data[i + 3] > 200) {
        count++;
        total += data[i];
        const x = (i / 4) % canvas.width,
          y = Math.floor(i / 4 / canvas.width);
        minX = Math.min(x, minX);
        minY = Math.min(y, minY);
        maxX = Math.max(x, maxX);
        maxY = Math.max(y, maxY);
      }
    return {
      width: canvas.width,
      height: canvas.height,
      corner: data[3],
      color: total / count,
      count,
      minX,
      minY,
      maxX,
      maxY,
    };
  }, href);
}

try {
  let ready = false;
  for (let i = 0; i < 80; i++) {
    assert.equal(server.exitCode, null, logs);
    try {
      ready = (await fetch(`${base}/api/status`)).ok;
      if (ready) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert(ready, "Temporary production server must start");
  const status = await (await fetch(`${base}/api/status`)).json();
  assert.equal(status.connectionState, "disconnected");
  assert.deepEqual(status.accounts, []);
  for (const file of files) {
    const response = await fetch(`${base}/${file}?v=route1`);
    assert.equal(response.status, 200, file);
    assert.match(response.headers.get("content-type"), /image\//, file);
    assert.equal(
      hash(Buffer.from(await response.arrayBuffer())),
      hash(await readFile(join(root, "public", file))),
      file,
    );
    if (file.endsWith(".ico")) {
      const ico = await readFile(join(root, "public", file));
      assert.equal(ico.readUInt16LE(4), 3);
      assert.deepEqual([ico[6], ico[22], ico[38]], [16, 32, 48]);
    }
  }
  browser = await chromium.launch(
    process.env.BROWSER_EXECUTABLE
      ? {
          executablePath: process.env.BROWSER_EXECUTABLE,
        }
      : {},
  );

  // Initial links also work before React starts, with JavaScript disabled.
  for (const os of ["light", "dark"]) {
    const context = await browser.newContext({
      javaScriptEnabled: false,
      colorScheme: os,
    });
    const page = await context.newPage();
    await page.goto(base);
    assert.equal(
      await page.locator("#favicon").getAttribute("href"),
      "/icon.svg?v=route1",
    );
    assert.equal(
      await page.locator('link[rel="apple-touch-icon"]').getAttribute("href"),
      "/apple-touch-icon.png?v=route1",
    );
    checks.push({ javascript: false, os });
    await context.close();
  }

  for (const width of [390, 1440])
    for (const os of ["light", "dark"]) {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        colorScheme: os,
      });
      const page = await context.newPage();
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(base);
      for (const theme of ["light", "dark", "system"]) {
        await page
          .getByRole("button", { name: "Connections & settings" })
          .click();
        await page
          .getByRole("group", { name: "Appearance" })
          .getByRole("button", {
            name: theme[0].toUpperCase() + theme.slice(1),
            exact: true,
          })
          .click();
        for (const reload of [false, true]) {
          if (reload) await page.reload();
          const resolved = theme === "system" ? os : theme;
          const suffix = resolved === "dark" ? "-dark" : "";
          const expected = [
            `/favicon${suffix}.ico?v=route1`,
            `/favicon${suffix}.png?v=route1`,
            `/icon-${resolved}.svg?v=route1`,
          ];
          await page.waitForFunction(
            (hrefs) =>
              JSON.stringify(
                [...document.querySelectorAll('link[rel="icon"]')].map((link) =>
                  link.getAttribute("href"),
                ),
              ) === JSON.stringify(hrefs),
            expected,
          );
          assert.equal(
            await page.locator("html").getAttribute("data-theme"),
            resolved,
          );
          assert.equal(
            await page.evaluate(() => localStorage.getItem("wazex-theme")),
            theme,
          );
          for (const href of expected) {
            const icon = await pixels(page, href);
            assert.equal(icon.corner, 0, href);
            assert(icon.count > 20, href);
            assert(
              resolved === "dark" ? icon.color > 230 : icon.color < 45,
              href,
            );
          }
          const touch = await page
            .locator('link[rel="apple-touch-icon"]')
            .getAttribute("href");
          assert.equal(touch, "/apple-touch-icon.png?v=route1");
          const icon = await pixels(page, touch);
          assert.equal(icon.width, 180);
          assert.equal(icon.height, 180);
          assert.equal(icon.corner, 0);
          // Canvas unpremultiplies alpha with minor channel rounding.
          assert(Math.abs(icon.color - 245) < 0.1);
          assert(
            icon.count > 500 &&
              icon.minX >= 30 &&
              icon.minY >= 30 &&
              icon.maxX <= 150 &&
              icon.maxY <= 150,
          );
          checks.push({ width, os, theme, reload });
        }
      }
      const next = os === "dark" ? "light" : "dark";
      await page.emulateMedia({ colorScheme: next });
      await page.waitForFunction(
        (mode) =>
          document.querySelector("#favicon").getAttribute("href") ===
          `/icon-${mode}.svg?v=route1`,
        next,
      );
      checks.push({ width, os, systemChange: next });
      // Sample-data entry is shown in the desktop chart's empty state.
      if (width === 1440) {
        await page
          .getByRole("button", { name: "Preview with sample data" })
          .click();
      }
      await page.getByRole("button", { name: "Overview", exact: true }).click();
      await page
        .locator(width === 390 ? ".mobile-overview" : ".stat-grid")
        .waitFor();
      assert.equal(await page.locator(".brand svg, .brand img").count(), 0);
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
      );
      await page.screenshot({ path: join(artifact, `${width}-${os}.png`) });
      await context.close();
    }
  assert.deepEqual(errors, []);
} finally {
  if (browser) await browser.close();
  if (server.exitCode === null) {
    const stopped = once(server, "exit");
    server.kill("SIGTERM");
    await stopped;
  }
  await writeFile(join(artifact, "server.log"), logs);
  await rm(state, { recursive: true, force: true });
}
const report = {
  status: "passed",
  checks,
  assetChecks: files.length,
  errors,
  fixtureStopped: server.exitCode === 0,
  nativeIphoneTested: false,
};
assert.equal(report.fixtureStopped, true);
await writeFile(
  join(artifact, "report.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(
  JSON.stringify({
    status: "passed",
    browserChecks: checks.length,
    assetChecks: files.length,
    artifact,
  }),
);
