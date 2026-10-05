import { chromium } from "playwright";
import assert from "node:assert/strict";

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("http://127.0.0.1:4310");
  for (const width of [390, 320, 430]) {
    await page.setViewportSize({ width, height: 844 });
    await page.locator(".mobile-insights summary").click();
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
      `Expanded insights overflow at ${width}px`,
    );
    assert.equal(layout.navWidth, width);
    assert.ok(layout.heatmapWidth <= layout.overviewWidth);
    assert.ok(layout.heatmapContent > layout.heatmapWidth);
    const heatmap = page.locator(".mobile-insights .heatmap-scroll");
    await heatmap.evaluate((el) => {
      el.scrollLeft = el.scrollWidth;
    });
    assert.ok(await heatmap.evaluate((el) => el.scrollLeft > 0));
    await page.locator(".mobile-insights summary").click();
    assert.equal(
      await page.locator(".mobile-insights").getAttribute("open"),
      null,
    );
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth),
      width,
    );
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".mobile-insights summary").click();
  await page.locator(".mobile-insights").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "data/insights-after.png", fullPage: false });
  assert.deepEqual(errors, []);
  console.log(
    "Mobile insights verified at 320/390/430px: expand/collapse, contained heatmap scrolling, navigation width, no page overflow or errors.",
  );
} finally {
  await browser.close();
}
