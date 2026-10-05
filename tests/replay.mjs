import { chromium } from "playwright";
import assert from "node:assert/strict";

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const now = Date.now();
  const routes = Array.from({ length: 20 }, (_, i) => ({
    id: `fixture-${i}`,
    start: now - i * 60000,
    points: [
      [103 + i * 0.001, 1],
      [103 + i * 0.001, 1.01],
      [103.03, 1.015],
    ],
  }));
  const drives = routes.map((r) => ({
    id: r.id,
    start: r.start,
    end: r.start + 30000,
    meters: 1000,
    hasDetail: true,
  }));
  await page.route("**/api/drives?*", (r) => r.fulfill({ json: drives }));
  await page.route("**/api/routes", (r) =>
    r.fulfill({
      json: routes.filter((route) =>
        r.request().postDataJSON().ids.includes(route.id),
      ),
    }),
  );
  await page.goto("http://127.0.0.1:4310");
  const replay = page.getByRole("region", { name: "Your roads" });
  await replay.locator("path").first().waitFor();
  assert.equal(await replay.locator(".replay-network path").count(), 20);
  await replay.getByRole("button", { name: "Replay", exact: true }).click();
  await page.waitForTimeout(800);
  await replay.getByRole("button", { name: "Pause", exact: true }).click();
  const frozen = await replay.locator(".replay-heading span").textContent();
  const offsets = await replay
    .locator(".replay-network")
    .evaluate((el) =>
      Array.from(el.querySelectorAll("path")).map(
        (p) => p.style.strokeDashoffset,
      ),
    );
  await page.waitForTimeout(500);
  assert.equal(
    await replay.locator(".replay-heading span").textContent(),
    frozen,
  );
  assert.deepEqual(
    await replay
      .locator(".replay-network")
      .evaluate((el) =>
        Array.from(el.querySelectorAll("path")).map(
          (p) => p.style.strokeDashoffset,
        ),
      ),
    offsets,
  );
  await replay
    .getByRole("group", { name: "Replay speed" })
    .getByRole("button", { name: "4\u00d7", exact: true })
    .click();
  await replay.getByRole("button", { name: "Continue", exact: true }).click();
  await page.waitForTimeout(300);
  await replay
    .getByRole("group", { name: "Replay speed" })
    .getByRole("button", { name: "2\u00d7", exact: true })
    .click();
  assert.ok(
    Number(
      (await replay.locator(".replay-heading span").textContent()).split(
        "/",
      )[0],
    ) >= Number(frozen.split("/")[0]),
  );
  await replay
    .getByRole("group", { name: "Replay speed" })
    .getByRole("button", { name: "4\u00d7", exact: true })
    .click();
  await replay
    .getByRole("button", { name: "Replay", exact: true })
    .waitFor({ timeout: 6000 });
  assert.equal(
    await replay.locator(".replay-heading span").textContent(),
    "20 / 20 drives",
  );
  for (const width of [320, 390, 760, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await page
      .getByRole("region", { name: "Your roads" })
      .locator(".replay-network")
      .waitFor();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth),
      width,
    );
    for (const selector of [".replay-play", ".replay-speeds button"])
      assert.ok(
        await page
          .locator(selector)
          .evaluateAll((elements) =>
            elements.every((el) => el.getBoundingClientRect().height >= 44),
          ),
      );
  }
  await page.reload();
  await page.getByRole("group", { name: "Replay speed" }).waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "4\u00d7", exact: true })
      .getAttribute("aria-pressed"),
    "true",
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page
    .getByRole("region", { name: "Your roads" })
    .getByRole("button", { name: "Replay", exact: true })
    .click();
  await page.waitForTimeout(300);
  assert.equal(
    await page
      .locator(".replay-network circle")
      .evaluate((el) => el.style.opacity),
    "0",
  );
  await page.route("**/api/routes", (r) => r.fulfill({ json: [] }));
  await page.reload();
  await page.getByText("Saved routes will appear here.").waitFor();
  assert.equal(await page.locator(".replay-network").count(), 0);
  assert.deepEqual(errors, []);
  console.log(
    "Replay playback, pause, speed, persistence, reduced motion, empty state and responsive layout passed.",
  );
} finally {
  await browser.close();
}
