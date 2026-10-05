export function dayKey(time, timezone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(time);
}
export function driveSeconds(drive) {
  if (
    !Number.isFinite(drive.start) ||
    !Number.isFinite(drive.end) ||
    drive.end < drive.start
  )
    return null;
  return (drive.end - drive.start) / 1000;
}
function percentile(sorted, fraction) {
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position),
    upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}
export function analyze(drives, timezone = "Asia/Singapore") {
  const dayMap = new Map(),
    hours = Array(24).fill(0),
    weekdays = Array(7).fill(0);
  let meters = 0,
    seconds = 0,
    timedMeters = 0,
    incomplete = 0;
  const hourFmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    hourCycle: "h23",
  });
  const weekFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
  });
  const week = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const tripSpeeds = [];
  for (const d of drives) {
    meters += d.meters;
    const elapsed = driveSeconds(d);
    if (elapsed > 0 && Number.isFinite(d.meters) && d.meters > 0) {
      tripSpeeds.push((d.meters / elapsed) * 3.6);
    }
    if (elapsed !== null) {
      seconds += elapsed;
      if (elapsed > 0) timedMeters += d.meters;
    } else incomplete++;
    const key = dayKey(d.start, timezone);
    const existing = dayMap.get(key) || { date: key, meters: 0, count: 0 };
    existing.meters += d.meters;
    existing.count++;
    dayMap.set(key, existing);
    hours[Number(hourFmt.format(d.start))]++;
    weekdays[week.indexOf(weekFmt.format(d.start))]++;
  }
  const days = [...dayMap.values()].sort((a, b) =>
    a.date.localeCompare(b.date),
  );
  tripSpeeds.sort((a, b) => a - b);
  return {
    meters,
    seconds,
    incomplete,
    count: drives.length,
    activeDays: days.length,
    averageMeters: drives.length ? meters / drives.length : 0,
    averageSpeed: seconds ? (timedMeters / seconds) * 3.6 : 0,
    tripSpeed: tripSpeeds.length
      ? {
          median: percentile(tripSpeeds, 0.5),
          lower: percentile(tripSpeeds, 0.25),
          upper: percentile(tripSpeeds, 0.75),
          samples: tripSpeeds.length,
        }
      : null,
    longest: [...drives].sort((a, b) => b.meters - a.meters)[0],
    days,
    hours,
    weekdays: week.map((name, i) => ({ name, count: weekdays[i] })),
    busiestHour: hours.indexOf(Math.max(...hours)),
  };
}

export function routeCoordinates(detail) {
  // Preserve source payload separately; this renderer recognizes GeoJSON and WME point arrays.
  const found = [];
  function walk(v, depth = 0) {
    if (!v || depth > 20) return;
    if (Array.isArray(v)) {
      if (
        v.length > 1 &&
        v.every(
          (p) =>
            Array.isArray(p) &&
            p.length >= 2 &&
            typeof p[0] === "number" &&
            typeof p[1] === "number" &&
            Math.abs(p[0]) <= 180 &&
            Math.abs(p[1]) <= 90,
        )
      ) {
        found.push(v.map((p) => [p[0], p[1]]));
        return;
      }
      if (
        v.length > 1 &&
        v.every(
          (p) =>
            p && Number.isFinite(p.lon ?? p.x) && Number.isFinite(p.lat ?? p.y),
        )
      ) {
        found.push(v.map((p) => [p.lon ?? p.x, p.lat ?? p.y]));
        return;
      }
      v.forEach((p) => walk(p, depth + 1));
    } else if (typeof v === "object")
      Object.values(v).forEach((p) => walk(p, depth + 1));
  }
  walk(detail);
  return found.sort((a, b) => b.length - a.length)[0] || [];
}

export function demoDrives() {
  const rows = [],
    now = new Date();
  for (let day = 0; day < 85; day++) {
    if (day % 7 === 6) continue;
    for (let n = 0; n < (day % 3 === 0 ? 3 : 2); n++) {
      const start = new Date(now);
      start.setDate(start.getDate() - day);
      start.setHours(n === 0 ? 8 : n === 1 ? 18 : 21, (day * 13) % 60, 0, 0);
      const minutes = 15 + ((day * 7 + n * 11) % 42);
      rows.push({
        id: `demo-${day}-${n}`,
        start: +start,
        end: +start + minutes * 60000,
        meters: 3000 + ((day * 1793 + n * 3401) % 24000),
        hasDetail: false,
      });
    }
  }
  return rows.sort((a, b) => b.start - a.start);
}
