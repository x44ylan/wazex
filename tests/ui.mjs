import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
mkdirSync("data", { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
try {
  await page.route("**/api/drives?*", (route) => route.fulfill({ json: [] }));
  await page.goto("http://127.0.0.1:4310");
  await page.getByRole("button", { name: "Preview with sample data" }).click();
  await page
    .getByText("You’re exploring sample data. Your real archive is separate.")
    .waitFor();
  await page.screenshot({ path: "data/dashboard-demo.png", fullPage: true });
  await page
    .getByRole("button", { name: "Drive archive", exact: false })
    .click();
  await page.getByLabel("Search drives").fill("demo-1-");
  assert.ok((await page.locator("tbody tr").count()) > 0);
  await page.getByLabel("Search drives").fill("does-not-exist");
  await page.getByText("No drives match this view.").waitFor();
  await page.getByLabel("Search drives").fill("");
  await page.getByLabel("Sort drives").selectOption("longest");
  await page.locator("tbody tr").first().click();
  await page.getByRole("dialog").waitFor();
  await page.getByLabel("Close drive details").click();
  await page.getByRole("button", { name: "Connections & settings" }).click();
  await page.getByRole("heading", { name: "Waze", exact: true }).waitFor();
  await page.getByLabel("Distance units").selectOption("mi");
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await page.getByText("Miles", { exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".mobile-overview").waitFor();
  await page.getByLabel("Time range").selectOption("7");
  assert.equal(await page.getByLabel("Time range").inputValue(), "7");
  await page.getByLabel("Time range").selectOption("all");
  assert.equal(await page.getByRole("navigation").count(), 1);
  assert.equal(await page.locator(".mobile-drive-list").count(), 1);
  await page.getByRole("button", { name: "Drive archive" }).click();
  await page.locator(".mobile-drive-list").waitFor();
  await page.locator(".mobile-drive").first().click();
  await page.getByRole("dialog").waitFor();
  await page.getByLabel("Close drive details").click();
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await page.locator(".mobile-overview").waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Overview", exact: true })
      .getAttribute("aria-current"),
    "page",
  );
  await page.mouse.move(0, 0);
  await page.screenshot({ path: "data/dashboard-mobile.png", fullPage: false });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  assert.equal(
    overflow,
    false,
    "Mobile viewport should not overflow horizontally",
  );
  assert.deepEqual(errors, []);
  await page.route("**/api/status", (route) =>
    route.abort("connectionrefused"),
  );
  await page
    .getByText("The local wazex server is unavailable.", { exact: false })
    .waitFor();
  await page.unroute("**/api/status");
  await page
    .getByText("The local wazex server is unavailable.", { exact: false })
    .waitFor({ state: "hidden" });
  console.log(
    "UI verified: demo separation, archive search/sort, details, units, desktop/mobile, outage recovery, no page errors.",
  );
} finally {
  await browser.close();
}
