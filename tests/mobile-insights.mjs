import { chromium } from "playwright";
import assert from "node:assert/strict";

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.BROWSER_EXECUTABLE,
});
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  for (const width of [390, 320, 430]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(process.env.WAZEX_URL || "http://127.0.0.1:4310");
    const heatmap = page.locator(".mobile-insights .heatmap-scroll");
    await heatmap.waitFor();
    for (const label of [
      "Longest drive",
      "Active days",
      "Busiest departure hour",
    ]) {
      assert.equal(await page.getByText(label, { exact: true }).count(), 0);
    }
    assert.equal(
      await page
        .locator(".mobile-chart + .mobile-insights .heatmap-scroll")
        .count(),
      1,
    );
    assert.equal(
      await page
        .locator(".mobile-metrics > div")
        .evaluateAll((items) =>
          items.every((item) => getComputedStyle(item).textAlign === "center"),
        ),
      true,
    );
    const layout = await page.evaluate(() => {
      const heatmap = document.querySelector(
        ".mobile-insights .heatmap-scroll",
      );
      const overview = document.querySelector(".mobile-overview");
      const nav = document.querySelector("nav");
      return {
        pageWidth: document.documentElement.scrollWidth,
        viewportWidth: innerWidth,
        overviewWidth: overview.getBoundingClientRect().width,
        navWidth: nav.getBoundingClientRect().width,
        heatmapWidth: heatmap.clientWidth,
        heatmapContent: heatmap.scrollWidth,
      };
    });
    assert.equal(
      layout.pageWidth,
      width,
      `Mobile overview overflows at ${width}px`,
    );
    assert.equal(layout.navWidth, width);
    assert.ok(layout.heatmapWidth <= layout.overviewWidth);
    assert.ok(layout.heatmapContent > layout.heatmapWidth);
    assert.ok(
      await heatmap.evaluate(
        (el) => Math.abs(el.scrollWidth - el.clientWidth - el.scrollLeft) <= 1,
      ),
      `Heatmap should start at the newest dates at ${width}px`,
    );
    await heatmap.evaluate((el) => {
      el.scrollLeft = 0;
    });
    await page.getByLabel("Time range").selectOption("30");
    assert.equal(await heatmap.evaluate((el) => el.scrollLeft), 0);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".mobile-insights").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "data/insights-after.png", fullPage: false });
  assert.deepEqual(errors, []);
  console.log(
    "Mobile overview verified at 320/390/430px: heatmap follows the line chart, opens at the newest dates, and scrolls without widening the page.",
  );
} finally {
  await browser.close();
}
