import "./waze-http.mjs";
import { readFileSync } from "node:fs";
const fixtureFetch = globalThis.fetch;
globalThis.fetch = async (input, options) => {
  const faults = JSON.parse(
    readFileSync(process.env.WAZEX_FIXTURE_FAULTS, "utf8"),
  );
  const path = new URL(input).pathname;
  const status = path.endsWith("/app/Session")
    ? faults.session
    : path.endsWith("/Archive/List")
      ? faults.list
      : path.endsWith("/Archive/SessionGPS")
        ? faults.detail
        : 0;
  if (faults.slowDetails && path.endsWith("/Archive/List")) {
    const data = await (await fixtureFetch(input, options)).json();
    const rows = data.archives.objects;
    if (rows.length) rows.push({ ...rows[0], id: "fixture-drive-delayed" });
    return Response.json(data);
  }
  if (
    faults.slowDetails &&
    new URL(input).searchParams.get("id") === "fixture-drive-delayed"
  )
    await new Promise((resolve) => setTimeout(resolve, 4000));
  if (status)
    return new Response("{}", {
      status,
      headers: { "Content-Type": "application/json" },
    });
  return fixtureFetch(input, options);
};
