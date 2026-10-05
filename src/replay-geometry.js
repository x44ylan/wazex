// All drives share one geographic projection; archived payloads remain untouched.
export function projectRoutes(routes) {
  const valid = routes
    .map((route) => ({
      ...route,
      points: route.points.filter(
        (p) =>
          Array.isArray(p) &&
          Number.isFinite(p[0]) &&
          Number.isFinite(p[1]) &&
          Math.abs(p[0]) <= 180 &&
          Math.abs(p[1]) <= 85,
      ),
    }))
    .filter((route) => route.points.length > 1)
    .sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
  if (!valid.length) return [];
  const mercator = ([lon, lat]) => [
    lon,
    (-Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) * 180) / Math.PI,
  ];
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  const projected = valid.map((route) => ({
    ...route,
    points: route.points.map((p) => {
      const [x, y] = mercator(p);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      return [x, y];
    }),
  }));
  const scale = Math.min(
    560 / Math.max(maxX - minX, 1e-8),
    270 / Math.max(maxY - minY, 1e-8),
  );
  const offsetX = (600 - (maxX - minX) * scale) / 2,
    offsetY = (310 - (maxY - minY) * scale) / 2;
  return projected.map((route) => ({
    id: route.id,
    start: route.start,
    path: route.points
      .map(
        ([x, y], i) =>
          `${i ? "L" : "M"}${((x - minX) * scale + offsetX).toFixed(2)},${((y - minY) * scale + offsetY).toFixed(2)}`,
      )
      .join(" "),
  }));
}
