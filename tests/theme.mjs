import { chromium } from "playwright";
import assert from "node:assert/strict";

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  await page.emulateMedia({ reducedMotion: "reduce" });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("http://127.0.0.1:4310");
  await page.getByRole("button", { name: "Connections & settings" }).click();
  const toggle = page.getByRole("button", { name: "Dark", exact: true });
  await toggle.click();
  assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
  await page.locator(".connection-tools summary").click();
  const contrast = await page.evaluate(() => {
    const luminance = (color) =>
      color
        .match(/[\d.]+/g)
        .slice(0, 3)
        .map(Number)
        .map((channel) => {
          const value = channel / 255;
          return value <= 0.04045
            ? value / 12.92
            : ((value + 0.055) / 1.055) ** 2.4;
        })
        .reduce(
          (total, value, index) =>
            total + value * [0.2126, 0.7152, 0.0722][index],
          0,
        );
    return [
      ".setting-description",
      ".connection-tools .primary",
      '.theme-options button[aria-pressed="true"]',
    ].map((selector) => {
      const el = document.querySelector(selector);
      const style = getComputedStyle(el);
      const background =
        selector === ".setting-description"
          ? getComputedStyle(el.closest(".settings-panel")).backgroundColor
          : style.backgroundColor;
      const values = [luminance(style.color), luminance(background)].sort(
        (a, b) => b - a,
      );
      return (values[0] + 0.05) / (values[1] + 0.05);
    });
  });
  assert.ok(
    contrast.every((ratio) => ratio >= 4.5),
    "Dark settings text and controls need readable contrast",
  );
  assert.equal(
    await page
      .locator(".settings-panel")
      .first()
      .evaluate((el) => getComputedStyle(el).backgroundColor),
    "rgb(26, 29, 36)",
  );
  await page.reload();
  assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await page.locator(".stat-grid").waitFor();
  await page.screenshot({ path: "data/theme-desktop.png", fullPage: false });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Connections & settings" }).click();
  await page.locator(".mobile-settings").waitFor();
  assert.equal(await toggle.getAttribute("aria-pressed"), "true");
  assert.equal(
    await page
      .locator("body")
      .evaluate((el) => getComputedStyle(el).backgroundColor),
    "rgb(17, 19, 24)",
  );
  assert.equal(
    await page
      .getByRole("navigation")
      .evaluate((el) => getComputedStyle(el).backgroundColor),
    "rgb(17, 19, 24)",
  );
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page
      .getByRole("group", { name: "Appearance" })
      .scrollIntoViewIfNeeded();
    const sizes = await page
      .getByRole("group", { name: "Appearance" })
      .getByRole("button")
      .evaluateAll((elements) =>
        elements.map((el) => el.getBoundingClientRect().height),
      );
    assert.ok(sizes.every((height) => height >= 44));
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth),
      width,
    );
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "data/theme-mobile.png", fullPage: false });
  await page.getByRole("button", { name: "Light", exact: true }).click();
  await page.reload();
  assert.equal(await page.locator("html").getAttribute("data-theme"), "light");
  assert.equal(
    await page.evaluate(() => localStorage.getItem("wazex-theme")),
    "light",
  );
  await page.getByRole("button", { name: "Connections & settings" }).click();
  await page.getByRole("button", { name: "System", exact: true }).click();
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForFunction(
    () => document.documentElement.dataset.theme === "dark",
  );
  await page.reload();
  assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
  assert.equal(
    await page.evaluate(() => localStorage.getItem("wazex-theme")),
    "system",
  );
  await page.emulateMedia({ colorScheme: "light" });
  await page.waitForFunction(
    () => document.documentElement.dataset.theme === "light",
  );
  assert.deepEqual(errors, []);
  console.log(
    "Appearance verified: light/dark/system, system changes, refresh persistence, desktop/mobile surfaces, 44px controls and no overflow or page errors.",
  );
} finally {
  await browser.close();
}
