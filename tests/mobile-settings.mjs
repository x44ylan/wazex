import { chromium } from "playwright";
import assert from "node:assert/strict";
import QRCode from "qrcode";

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const initial = await (
    await fetch("http://127.0.0.1:4310/api/status")
  ).json();
  let autoSync = initial.autoSync,
    settingsPosts = 0;
  await page.route("**/api/status", (route) =>
    route.fulfill({
      json: { ...initial, autoSync, running: false, progress: null },
    }),
  );
  await page.route("**/api/settings", (route) => {
    autoSync = route.request().postDataJSON().autoSync;
    settingsPosts++;
    return route.fulfill({ json: { saved: true } });
  });
  const login = {
    state: "token_created",
    region: "row",
    expiresAt: Date.now() + 120000,
    qrCode: await QRCode.toDataURL("wazex layout test fixture"),
    loginUrl: "https://www.waze.com/ul?fixture=phone-login",
  };
  await page.route("**/api/login", (route) => route.fulfill({ json: login }));
  await page.route("**/api/login/status", (route) =>
    route.fulfill({ json: login }),
  );
  await page.route("**/api/login/cancel", (route) =>
    route.fulfill({ json: { canceled: true } }),
  );
  await page.goto("http://127.0.0.1:4310");
  await page.getByRole("button", { name: "Connections & settings" }).click();
  await page.locator(".mobile-settings").waitFor();
  await page.getByLabel("Distance units").selectOption("mi");
  assert.equal(await page.getByLabel("Distance units").inputValue(), "mi");
  await page.getByLabel("Display timezone").selectOption("UTC");
  assert.equal(await page.getByLabel("Display timezone").inputValue(), "UTC");
  await page.getByLabel("Automatic sync").setChecked(!initial.autoSync);
  assert.equal(autoSync, !initial.autoSync);
  await page.getByLabel("Automatic sync").setChecked(initial.autoSync);
  assert.equal(settingsPosts, 2);
  assert.equal(await page.locator(".sync-log").getAttribute("open"), null);
  await page.locator(".sync-log summary").click();
  assert.notEqual(await page.locator(".sync-log").getAttribute("open"), null);
  await page.locator(".connection-tools summary").click();
  await page
    .getByRole("button", { name: /Reconnect Waze|Get Waze QR code/ })
    .click();
  await page
    .getByAltText(
      "Waze sign-in QR code. Scan with your phone to approve wazex.",
    )
    .waitFor();
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
      `Settings overflow at ${width}px`,
    );
    const targets = await page
      .locator(
        ".mobile-settings .button-row .primary, .mobile-settings .button-row .secondary, .mobile-settings select",
      )
      .evaluateAll((elements) =>
        elements.map((el) => ({
          height: el.getBoundingClientRect().height,
          width: el.getBoundingClientRect().width,
        })),
      );
    assert.ok(
      targets.every((target) => target.height >= 44 && target.width > 0),
      "Controls must have usable touch targets",
    );
  }
  await page
    .context()
    .route(login.loginUrl, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<p>Waze approval fixture</p>",
      }),
    );
  const link = page.getByRole("link", { name: "Open Waze to approve sign-in" });
  assert.equal(await link.getAttribute("href"), login.loginUrl);
  const popupPromise = page.waitForEvent("popup");
  await link.click();
  const popup = await popupPromise;
  await popup.waitForLoadState("domcontentloaded");
  assert.equal(popup.url(), login.loginUrl);
  await popup.close();
  await page.getByRole("button", { name: "Cancel sign-in" }).click();
  await page.locator(".qr-login").waitFor({ state: "hidden" });
  await page.locator(".sync-log summary").click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("heading", { name: "Settings", exact: true })
    .scrollIntoViewIfNeeded();
  await page.mouse.move(0, 0);
  await page.screenshot({
    path: "data/settings-mobile-after.png",
    fullPage: false,
  });
  assert.deepEqual(errors, []);
  console.log(
    "Mobile settings verified at 320/390px: units, timezone, automatic sync, QR/cancel, expandable history, touch targets, no overflow or page errors.",
  );
} finally {
  await browser.close();
}
