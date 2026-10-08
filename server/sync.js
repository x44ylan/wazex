import { retryRead } from "./recovery.js";

export const REGIONS = {
  row: "row-Descartes",
  na: "Descartes",
  il: "il-Descartes",
};

export async function syncDrives({
  store,
  client,
  region,
  onProgress = () => {},
  onAccount = () => {},
  sleep,
  now = Date.now,
}) {
  if (!REGIONS[region]) throw new Error("Choose a supported Waze region.");
  const read = (operation) => retryRead(operation, { sleep });
  const user = await read(() => client.session(region));
  const account = store.account(user, region);
  onAccount(account);
  store.set("activeAccount", account.id);
  const run = store.startRun(account.id);
  let added = 0,
    seen = 0,
    routeErrors = 0,
    routeError = null;
  try {
    const ids = new Set();
    let offset = 0;
    for (let page = 0; page < 2000; page++) {
      const result = await read(() => client.list(region, offset));
      const rows = Array.isArray(result) ? result : result?.rows;
      const total = Array.isArray(result) ? undefined : result?.total;
      if (!Array.isArray(rows))
        throw new Error("Waze drive list format changed.");
      if (!rows.length) break;
      let fresh = 0;
      for (const raw of rows) {
        const key = typeof raw?.id === "string" ? raw.id : JSON.stringify(raw);
        if (ids.has(key)) continue;
        ids.add(key);
        fresh++;
        seen++;
        try {
          if (store.save(account.id, raw)) added++;
        } catch (error) {
          if (error.code !== "INVALID_DRIVE") throw error;
          store.deferDrive(account.id, raw, error.message);
        }
      }
      if (!fresh)
        throw new Error(
          "Waze repeated a drive page. Archive is partial; retry sync.",
        );
      onProgress({ phase: "drives", seen, added, offset });
      offset += rows.length;
      // Waze clamps offsets beyond the archive to the oldest record instead of
      // returning an empty page. Its total is the authoritative stopping point.
      if (Number.isInteger(total) && total >= 0 && ids.size >= total) break;
      if (page === 1999)
        throw new Error("Pagination limit reached; archive may be incomplete.");
    }
    const pending = store.pendingDetails(account.id, now());
    let fetched = 0,
      processed = 0;
    onProgress({
      phase: "routes",
      seen,
      added,
      fetched,
      processed,
      total: pending.length,
      routeErrors,
      routeError,
    });
    for (const d of pending) {
      try {
        await read(async () => {
          store.detail(account.id, d.id, await client.detail(region, d.id));
        });
        fetched++;
      } catch (error) {
        if (error.code === "AUTH_REQUIRED") throw error;
        store.deferDetail(account.id, d.id, error.message, now());
        routeErrors++;
        routeError ||= error.message;
      }
      processed++;
      onProgress({
        phase: "routes",
        seen,
        added,
        fetched,
        processed,
        total: pending.length,
        routeErrors,
        routeError,
      });
    }
    const invalidDrives = store.pendingDrives(account.id).length;
    const warnings = [];
    if (routeErrors)
      warnings.push(
        `${routeErrors} routes unavailable: ${routeError} Saved summaries remain available.`,
      );
    if (invalidDrives)
      warnings.push(
        `${invalidDrives} invalid drive records retained for recovery.`,
      );
    const warning = warnings.length
      ? `${warnings.join(" ")} Recovery will retry automatically.`
      : null;
    store.finishRun(
      run,
      warning ? "partial" : "complete",
      added,
      seen,
      warning,
    );
    store.set("lastSync", new Date().toISOString());
    return {
      account,
      added,
      seen,
      fetched,
      routeErrors,
      invalidDrives,
      warning,
    };
  } catch (error) {
    store.finishRun(run, "failed", added, seen, error.message);
    throw error;
  }
}
