import { useEffect, useMemo, useRef, useState } from "react";
import { Play, Pause, RotateCcw } from "lucide-react";
import { projectRoutes } from "./replay-geometry.js";

export default function DriveReplay({ account, drives, revision, demo }) {
  const [source, setSource] = useState([]),
    [load, setLoad] = useState("loading");
  const [phase, setPhase] = useState("ready"),
    [count, setCount] = useState(0);
  const [speed, setSpeed] = useState(() => {
    const value = Number(localStorage.getItem("wazex-replay-speed"));
    return [0.5, 1, 2, 4].includes(value) ? value : 1;
  });
  const paths = useRef([]),
    dot = useRef(null),
    progress = useRef(0),
    speedRef = useRef(speed);
  const ids = drives
    .map((d) => d.id)
    .sort()
    .join("|");
  const routes = useMemo(() => {
    const selected = new Set(ids.split("|"));
    return projectRoutes(source.filter((r) => selected.has(r.id)));
  }, [source, ids]);
  useEffect(() => {
    setSource([]);
    if (!account || demo) {
      setLoad("empty");
      return;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    setLoad("loading");
    fetch(`/api/routes?account=${encodeURIComponent(account)}`, {
      signal: controller.signal,
    })
      .then((r) => {
        if (!r.ok) throw new Error();
        return r.json();
      })
      .then((data) => {
        setSource(data);
        setLoad("done");
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoad("error");
        else if (!cancelled) setLoad("error");
      })
      .finally(() => clearTimeout(timeout));
    let cancelled = false;
    return () => {
      cancelled = true;
      clearTimeout(timeout);
      controller.abort();
    };
  }, [account, revision, demo]);
  useEffect(() => {
    setPhase("ready");
    setCount(routes.length);
    progress.current = 0;
  }, [routes]);
  useEffect(() => {
    speedRef.current = speed;
    localStorage.setItem("wazex-replay-speed", String(speed));
  }, [speed]);
  useEffect(() => {
    const hide = () => {
      if (document.hidden) setPhase((p) => (p === "playing" ? "paused" : p));
    };
    document.addEventListener("visibilitychange", hide);
    return () => document.removeEventListener("visibilitychange", hide);
  }, []);
  useEffect(() => {
    if (phase !== "playing") {
      if (phase === "ready" || phase === "done")
        paths.current.forEach((p) => {
          if (p) {
            p.style.opacity = ".38";
            p.style.strokeDasharray = "none";
            p.style.strokeDashoffset = "0";
          }
        });
      if (dot.current) dot.current.style.opacity = "0";
      return;
    }
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const duration = Math.max(12, Math.min(60, routes.length * 0.35)) * 1000;
    const lengths = paths.current.map((p) => p?.getTotalLength() || 0);
    let frame,
      last = null,
      shown = -1;
    const draw = (now) => {
      if (last !== null)
        progress.current +=
          (Math.min(now - last, 100) * speedRef.current) / duration;
      last = now;
      const position = Math.min(progress.current, 1) * routes.length,
        index = Math.floor(position),
        fraction = position - index;
      paths.current.forEach((p, i) => {
        if (!p) return;
        p.style.opacity = i < index ? ".38" : i === index ? "1" : "0";
        p.style.strokeDasharray =
          i === index ? `${lengths[i]} ${lengths[i]}` : "none";
        p.style.strokeDashoffset =
          i === index ? String(lengths[i] * (reduced ? 1 : 1 - fraction)) : "0";
      });
      if (dot.current && !reduced && index < routes.length) {
        const p = paths.current[index].getPointAtLength(
          lengths[index] * fraction,
        );
        dot.current.setAttribute("cx", p.x);
        dot.current.setAttribute("cy", p.y);
        dot.current.style.opacity = "1";
      }
      if (shown !== index) {
        shown = index;
        setCount(index);
      }
      if (progress.current >= 1) {
        setPhase("done");
        setCount(routes.length);
        return;
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [phase, routes]);
  const play = () => {
    if (phase === "ready" || phase === "done") {
      progress.current = 0;
      setCount(0);
    }
    setPhase(phase === "playing" ? "paused" : "playing");
  };
  if (demo) return null;
  return (
    <section className="panel drive-replay" aria-label="Your roads">
      <div className="replay-heading">
        <h2>Your roads</h2>
        <span aria-live="polite">
          {routes.length ? `${count} / ${routes.length} drives` : ""}
        </span>
      </div>
      {routes.length ? (
        <>
          <svg
            className="replay-network"
            viewBox="0 0 600 310"
            role="img"
            aria-label="Your saved routes, drawn in chronological order"
          >
            {routes.map((r, i) => (
              <path
                key={r.id}
                ref={(p) => {
                  paths.current[i] = p;
                }}
                d={r.path}
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ opacity: 0.38 }}
              />
            ))}
            <circle
              ref={dot}
              r="3.5"
              fill="currentColor"
              style={{ opacity: 0 }}
            />
          </svg>
          <div className="replay-controls">
            <button className="replay-play" onClick={play}>
              {phase === "playing" ? (
                <Pause size={16} />
              ) : phase === "done" ? (
                <RotateCcw size={16} />
              ) : (
                <Play size={16} />
              )}{" "}
              <span>
                {phase === "playing"
                  ? "Pause"
                  : phase === "paused"
                    ? "Continue"
                    : "Replay"}
              </span>
            </button>
            <div
              className="replay-speeds"
              role="group"
              aria-label="Replay speed"
            >
              {[0.5, 1, 2, 4].map((s) => (
                <button
                  key={s}
                  type="button"
                  aria-pressed={speed === s}
                  onClick={() => setSpeed(s)}
                >
                  {s}×
                </button>
              ))}
            </div>
          </div>
        </>
      ) : (
        <p className="replay-empty">
          {load === "loading"
            ? "Loading your roads…"
            : load === "error"
              ? "Couldn’t load routes. Refresh to try again."
              : "Saved routes will appear here."}
        </p>
      )}
    </section>
  );
}
