// Preloaded only by the isolated HTTP integration test; no real Waze requests.
let challenge = 0;
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(input);
  if (url.origin !== "https://www.waze.com")
    throw new Error("Unexpected fixture origin");
  const json = (body, status = 200, cookies = []) => {
    const headers = new Headers({ "Content-Type": "application/json" });
    for (const cookie of cookies) headers.append("Set-Cookie", cookie);
    return new Response(JSON.stringify(body), { status, headers });
  };
  if (url.pathname === "/login/get")
    return json({}, 200, [
      "_csrf_token=fixture-csrf; Path=/; Secure",
      "_web_session=fixture-guest; Path=/; Secure; HttpOnly",
    ]);
  if (url.pathname.endsWith("/token"))
    return json({ token: `fixture-challenge-${++challenge}` }, 201);
  if (url.pathname.endsWith("/lookup"))
    return json({ flowState: "consent_granted" }, 201);
  if (url.pathname.endsWith("/session"))
    return json({}, 200, [
      "_web_session=fixture-approved; Path=/; Secure; HttpOnly",
    ]);
  if (!options.headers?.Cookie?.includes("_web_session=fixture-approved"))
    return json({}, 401);
  if (url.pathname.endsWith("/app/Session"))
    return process.env.WAZEX_FIXTURE_SESSION_STATUS
      ? json({}, Number(process.env.WAZEX_FIXTURE_SESSION_STATUS))
      : json({ id: "fixture-account", userName: "Fixture driver" });
  if (url.pathname.endsWith("/Archive/List"))
    return json({
      archives: {
        objects:
          Number(url.searchParams.get("offset")) === 0
            ? [
                {
                  id: "fixture-drive",
                  startTime: 1000,
                  endTime: 61000,
                  totalRoadMeters: 1200,
                  hasFullSession: true,
                },
              ]
            : [],
      },
    });
  if (url.pathname.endsWith("/Archive/SessionGPS"))
    return json({
      coordinates: [
        [1, 2],
        [2, 3],
      ],
    });
  throw new Error(`Unexpected Waze fixture path ${url.pathname}`);
};
