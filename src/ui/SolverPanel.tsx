import { useCallback, useEffect, useRef, useState } from "react";
import type { GPUContext } from "../gpu/device";
import { createSolver } from "../sim/lbm";
import type { FlowStats, Solver } from "../sim/lbm";
import { FlowViewer } from './FlowViewer';

const initialStats: FlowStats = {
  steps: 0,
  inletSpeed: 0,
  densityMin: 1,
  densityMax: 1,
  maxSpeed: 0,
  invalidCells: 0,
};
const buttonStyle =
  "rounded-lg border border-cyan-400/40 px-4 py-2 text-sm text-cyan-200 hover:bg-cyan-400/10 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-cyan-400";

export function SolverPanel({ context }: { context: GPUContext }) {
  const solver = useRef<Solver | null>(null);
  const controller = useRef<AbortController | null>(null);
  const inFlight = useRef(false);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [targetSpeed, setTargetSpeed] = useState(0.03);
  const [stats, setStats] = useState(initialStats);
  const [error, setError] = useState("");

  useEffect(() => {
    const abort = new AbortController();
    controller.current = abort;
    const pauseWhenHidden = () => {
      if (document.hidden) setRunning(false);
    };
    document.addEventListener("visibilitychange", pauseWhenHidden);
    return () => {
      abort.abort();
      solver.current?.dispose();
      solver.current = null;
      document.removeEventListener("visibilitychange", pauseWhenHidden);
    };
  }, [context]);

  const operate = useCallback(
    async (reset = false, count = 1) => {
      const abort = controller.current;
      if (!abort || abort.signal.aborted || inFlight.current) return false;
      inFlight.current = true;
      setBusy(true);
      setError("");
      try {
        if (!solver.current)
          solver.current = await createSolver(context, abort.signal, {
            targetSpeed,
          });
        const next = reset
          ? await solver.current.reset()
          : await solver.current.step(count);
        if (!abort.signal.aborted) setStats(next);
        return !abort.signal.aborted;
      } catch (failure) {
        if (!abort.signal.aborted) {
          if (solver.current) setStats(solver.current.stats);
          setError(
            failure instanceof Error ? failure.message : "Airflow step failed.",
          );
          setRunning(false);
        }
        return false;
      } finally {
        inFlight.current = false;
        if (!abort.signal.aborted) setBusy(false);
      }
    },
    [context, targetSpeed],
  );

  useEffect(() => {
    if (!running) return;
    let cancelled = false;
    let frame = 0;
    async function tick() {
      if (cancelled) return;
      if (document.hidden) {
        setRunning(false);
        return;
      }
      const completed = await operate(false, 4);
      if (completed && !cancelled)
        frame = requestAnimationFrame(() => {
          void tick();
        });
    }
    frame = requestAnimationFrame(() => {
      void tick();
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [running, operate]);

  function changeSpeed(value: number) {
    solver.current?.dispose();
    solver.current = null;
    setTargetSpeed(value);
  }

  return (
    <section
      aria-labelledby="solver-heading"
      className="space-y-5 rounded-xl border border-slate-700 bg-slate-950/60 p-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 id="solver-heading" className="font-medium text-white">
          Empty-tunnel airflow
        </h3>
        <p className="text-sm text-cyan-300">
          {running ? "Running" : busy ? "Working..." : "Paused"}
        </p>
      </div>
      <p className="text-sm text-slate-300">
        Inlet at x = 0 → Wind along +X → Outlet at x = end
      </p>
      <div>
        <label htmlFor="inlet-speed" className="block text-sm text-slate-300">
          Target inlet speed: {targetSpeed.toFixed(3)} lattice units
        </label>
        <input
          id="inlet-speed"
          type="range"
          min="0"
          max="0.08"
          step="0.005"
          value={targetSpeed}
          disabled={running || busy || stats.steps > 0}
          onChange={(event) => changeSpeed(Number(event.target.value))}
          className="mt-3 w-full accent-cyan-400 disabled:opacity-40"
        />
        <p className="mt-1 text-xs text-slate-400">
          Wind ramps up over 300 simulation steps. Reset before changing speed.
          Physical m/s scaling comes later.
        </p>
      </div>
      <div className="flex flex-wrap gap-3">
        <button
          className={buttonStyle}
          disabled={!running && (busy || Boolean(error))}
          onClick={() => setRunning((value) => !value)}
        >
          {running ? "Pause" : "Run"}
        </button>
        <button
          className={buttonStyle}
          disabled={running || busy || Boolean(error)}
          onClick={() => {
            void operate();
          }}
        >
          Step once
        </button>
        <button
          className={buttonStyle}
          disabled={running || busy}
          onClick={() => {
            void operate(true);
          }}
        >
          Reset fluid
        </button>
      </div>
      <dl className="grid gap-4 text-sm sm:grid-cols-2">
        {[
          ["Simulation steps", stats.steps.toLocaleString()],
          ["Current inlet speed", stats.inletSpeed.toFixed(6)],
          [
            "Density range",
            `${stats.densityMin.toFixed(6)} – ${stats.densityMax.toFixed(6)}`,
          ],
          ["Maximum flow speed", stats.maxSpeed.toFixed(6)],
          ["Maximum Mach estimate", (stats.maxSpeed * Math.sqrt(3)).toFixed(4)],
          ["Flagged unstable cells", String(stats.invalidCells)],
        ].map(([name, value]) => (
          <div key={name}>
            <dt className="text-slate-400">{name}</dt>
            <dd className="mt-1 font-mono text-slate-200">{value}</dd>
          </div>
        ))}
      </dl>
      <FlowViewer context={context} steps={stats.steps} targetSpeed={targetSpeed} />
      <p className="text-xs leading-5 text-slate-400">
        Density and speed checks cover every fluid cell after each batch. Side,
        top, and bottom boundaries are free-slip; there is no ground friction or
        object yet. Values use lattice units. The slice displays the calculated field.
      </p>
      {error && (
        <p
          role="alert"
          className="rounded-lg bg-amber-400/10 p-3 text-sm text-amber-200"
        >
          {error}
        </p>
      )}
    </section>
  );
}
