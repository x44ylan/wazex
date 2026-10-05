export const SYNC_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

export async function retryRead(
  read,
  { sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {},
) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await read();
    } catch (error) {
      const permanent =
        error.code === "AUTH_REQUIRED" ||
        (error.status >= 400 &&
          error.status < 500 &&
          ![408, 429].includes(error.status));
      if (permanent || attempt === 2) throw error;
      await sleep(1000 * 2 ** attempt);
    }
  }
}

export function recoveryAfter(previous, now = Date.now()) {
  const attempts = Math.min((previous?.attempts || 0) + 1, 8);
  return {
    attempts,
    nextAt: now + SYNC_INTERVAL_MS,
  };
}
