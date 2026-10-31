import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GPUContext } from "../gpu/device";
import { createSolver } from "../sim/lbm";
import type { FlowStats, Solver } from "../sim/lbm";
import { FlowViewer } from "./FlowViewer";
import { initializeFluid } from "../sim/initialize";
import { createObstacle } from "../geometry/sphere";
import type { ObstacleKind } from "../geometry/sphere";
import type { ForceSample } from "../sim/forces";
import { ForcePanel } from "./ForcePanel";
import { resolutionScale } from '../gpu/grid';
import { createTracers } from '../render/tracers';
import type { Tracers } from '../render/tracers';
import type { TracerFrame } from '../render/tracer-seeds';
import { createFilaments } from '../render/filaments';
import type { Filaments as Smoke, FilamentFrame as SmokeFrame } from '../render/filaments';

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
  const scale = resolutionScale(context.grid);
  const rampSteps = Math.round(300*scale*scale);
  const solver = useRef<Solver | null>(null);
  const tracers = useRef<Tracers | null>(null);
  const smoke = useRef<Smoke | null>(null);
  const [smokeEnabled, setSmokeEnabled] = useState(true);
  const [smokeFrame, setSmokeFrame] = useState<SmokeFrame | null>(null);
  const [smokeError, setSmokeError] = useState('');
  const [batchSteps, setBatchSteps] = useState(16);
  const [tracersEnabled, setTracersEnabled] = useState(false);
  const [tracerFrame, setTracerFrame] = useState<TracerFrame | null>(null);
  const [tracerError, setTracerError] = useState('');
  const controller = useRef<AbortController | null>(null);
  const inFlight = useRef(false);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [targetSpeed, setTargetSpeed] = useState(Math.min(0.08, 0.03/scale));
  const [stats, setStats] = useState(initialStats);
  const [error, setError] = useState("");
  const [forceHistory, setForceHistory] = useState<ForceSample[]>([]);
  const [timing, setTiming] = useState<{ msPerStep: number | null; scratchBytes: number } | null>(null);
  const [obstacleKind, setObstacleKind] = useState<ObstacleKind>("sphere");
  const obstacle = useMemo(
    () => createObstacle(context.grid, obstacleKind),
    [context.grid, obstacleKind],
  );

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
      tracers.current?.dispose();
      tracers.current = null;
      smoke.current?.dispose(); smoke.current = null;
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
            obstacle: obstacleKind,
            rampSteps,
          });
        const started = performance.now();
        const next = reset
          ? await solver.current.reset()
          : await solver.current.step(count);
        if (!abort.signal.aborted) {
          setStats(next);
          if (reset) {
            tracers.current?.dispose(); tracers.current = null; setTracerFrame(null); setTracerError('');
            smoke.current?.dispose(); smoke.current = null; setSmokeFrame(null); setSmokeError('');
          } else if (tracersEnabled) {
            try {
              if (!tracers.current) tracers.current = await createTracers(context, obstacle, abort.signal);
              const positions = await tracers.current.advance(count);
              if (!abort.signal.aborted) setTracerFrame({ positions, step: next.steps });
            } catch (failure) {
              if (!abort.signal.aborted) {
                tracers.current?.dispose(); tracers.current = null; setTracerFrame(null); setTracersEnabled(false);
                setTracerError(failure instanceof Error ? failure.message : 'Visualization unavailable.');
              }
            }
          }
          if (!reset && smokeEnabled && !abort.signal.aborted) {
            try {
              if (!smoke.current) smoke.current = await createFilaments(context,obstacle,abort.signal);
              const frame = await smoke.current.advance(count,next.steps);
              if (!abort.signal.aborted) setSmokeFrame(frame);
            } catch (failure) {
              if (!abort.signal.aborted) {
                smoke.current?.dispose(); smoke.current = null; setSmokeFrame(null); setSmokeEnabled(false);
                setSmokeError(failure instanceof Error ? failure.message : 'Visualization unavailable.');
              }
            }
          }
          if (abort.signal.aborted) return false;
          setTiming({ msPerStep: reset ? null : (performance.now()-started)/count, scratchBytes: solver.current.scratchBytes+(tracers.current?.bytes ?? 0)+(smoke.current?.bytes ?? 0) });
          if (reset) setForceHistory([]);
          else {
            const sample = solver.current.lastForceSamples.at(-1);
            if (sample)
              setForceHistory((previous) => [...previous.slice(-599), sample]);
          }
        }
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
    [context, targetSpeed, obstacleKind, rampSteps, tracersEnabled, obstacle, smokeEnabled],
  );

  useEffect(() => {
    if (!running) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function tick() {
      if (cancelled) return;
      if (document.hidden) {
        setRunning(false);
        return;
      }
      const completed = await operate(false, batchSteps);
      if (completed && !cancelled)
        timer = setTimeout(() => {
          void tick();
        }, 0);
    }
    timer = setTimeout(() => {
      void tick();
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [running, operate, batchSteps]);

  function changeSpeed(value: number) {
    solver.current?.dispose();
    solver.current = null;
    tracers.current?.dispose(); tracers.current = null; setTracerFrame(null); setTracerError('');
    smoke.current?.dispose(); smoke.current = null; setSmokeFrame(null); setSmokeError('');
    setTargetSpeed(value);
    setForceHistory([]);
  }

  async function changeObstacle(kind: ObstacleKind) {
    const abort = controller.current;
    if (!abort || abort.signal.aborted || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      solver.current?.dispose();
      solver.current = null;
      tracers.current?.dispose(); tracers.current = null; setTracerFrame(null); setTracerError('');
      smoke.current?.dispose(); smoke.current = null; setSmokeFrame(null); setSmokeError('');
      // Reinitialize the whole fluid when geometry changes. Former solids must
      // never become fluid with zero populations left inside them.
      await initializeFluid(context, abort.signal);
      if (!abort.signal.aborted) {
        setObstacleKind(kind);
        setStats(initialStats);
        setTiming(null);
        setForceHistory([]);
      }
    } catch (failure) {
      if (!abort.signal.aborted)
        setError(
          failure instanceof Error
            ? failure.message
            : "Could not reset the scene.",
        );
    } finally {
      inFlight.current = false;
      if (!abort.signal.aborted) setBusy(false);
    }
  }

  return (
    <section
      aria-labelledby="solver-heading"
      className="space-y-3"
    >
      <h3 id="solver-heading" className="sr-only">Wind-tunnel airflow</h3>
      <div className="flex flex-wrap items-center gap-3 px-4 pt-3">
      <div>
        <label className="text-sm text-slate-300">
          Test scene
          <select
            value={obstacleKind}
            disabled={running || busy}
            onChange={(event) => {
              void changeObstacle(event.target.value as ObstacleKind);
            }}
            className="ml-3 rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 disabled:opacity-40"
          >
            <option value="sphere">Stationary sphere</option>
            <option value="none">Empty tunnel</option>
          </select>
        </label>
      </div>


        <button
          className={buttonStyle}
          disabled={!running && (busy || Boolean(error))}
          onClick={() => setRunning((value) => !value)}
        >
          {running ? "Pause" : "Run"}
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
        <span className="ml-auto text-xs text-cyan-300">{running ? "Running" : busy ? "Working..." : "Paused"}</span>
      </div>
      <FlowViewer
        context={context}
        steps={stats.steps}
        targetSpeed={targetSpeed}
        obstacle={obstacle}
        tracerFrame={tracerFrame}
        tracersEnabled={tracersEnabled}
        tracerBusy={running || busy}
        tracerError={tracerError}
        running={running}
        smokeFrame={smokeFrame}
        smokeEnabled={smokeEnabled}
        smokeError={smokeError}
        onSmokeEnabled={(enabled) => {
          if (inFlight.current || running) return;
          smoke.current?.dispose(); smoke.current = null; setSmokeFrame(null); setSmokeError(''); setSmokeEnabled(enabled);
          setTiming((previous) => previous ? { ...previous, scratchBytes: (solver.current?.scratchBytes ?? 0)+(tracers.current?.bytes ?? 0) } : null);
        }}
        onTracersEnabled={(enabled) => {
          if (inFlight.current || running) return;
          tracers.current?.dispose(); tracers.current = null;
          setTracerFrame(null); setTracerError(''); setTracersEnabled(enabled);
          setTiming((previous) => previous ? { ...previous, scratchBytes: (solver.current?.scratchBytes ?? 0)+(smoke.current?.bytes ?? 0) } : null);
        }}
      />
      <details className="mx-4 rounded-lg border border-slate-800 px-3 py-2">
        <summary className="cursor-pointer text-xs text-slate-400">Wind settings</summary>
        <div className="mt-3 space-y-3">
        <button
          className={buttonStyle}
          disabled={running || busy || Boolean(error)}
          onClick={() => {
            void operate();
          }}
        >
          Step once
        </button>
      <div>
        <label htmlFor="inlet-speed" className="block text-sm text-slate-300">
          Target inlet speed: {targetSpeed.toFixed(4)} lattice units
        </label>
        <input
          id="inlet-speed"
          type="range"
          min="0"
          max="0.08"
          step="0.0001"
          value={targetSpeed}
          disabled={running || busy || stats.steps > 0}
          onChange={(event) => changeSpeed(Number(event.target.value))}
          className="mt-3 w-full accent-cyan-400 disabled:opacity-40"
        />
        <p className="mt-1 text-xs text-slate-400">
          Wind ramps up over {rampSteps.toLocaleString()} simulation steps. Reset before changing speed.
          Resolution presets adjust the initial lattice speed and ramp duration to keep the starting Reynolds number comparable. Very small fallback grids cap the initial speed. Physical m/s scaling comes later.
        </p>
      </div>
        <label className="text-sm text-slate-300">Simulation pace<select value={batchSteps} disabled={running || busy} onChange={(event) => setBatchSteps(Number(event.target.value))} className="ml-3 rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 disabled:opacity-40"><option value="4">Gentle — 4 steps/update</option><option value="8">Balanced — 8 steps/update</option><option value="16">Fast — 16 steps/update</option></select></label>        {obstacle.sphere && (
          <p className="mt-2 text-xs leading-5 text-slate-400">
            Sphere diameter: {(obstacle.sphere.radius * 2).toFixed(2)} cells ·{" "}
            {obstacle.solidCells} solid cells · Blockage:{" "}
            {(obstacle.blockage * 100).toFixed(2)}% · Effective inlet Re:{" "}
            {(
              (stats.inletSpeed * obstacle.sphere.radius * 2) /
              ((0.6 - 0.5) / 3)
            ).toFixed(2)}
            . This is a coarse, low-Reynolds-number demonstration. Force
            readings are provisional.
          </p>
        )}
        <p className="text-xs text-slate-500">Reset before changing speed. Scene and resolution changes start a fresh flow.</p>
        </div>
      </details>
      <details className="mx-4 rounded-xl border border-slate-800 p-4">
        <summary className="cursor-pointer text-sm text-slate-400">Simulation diagnostics</summary>
        <div className="mt-4 space-y-4">
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
          ['Latest batch wall time / step', timing?.msPerStep != null ? `${timing.msPerStep.toFixed(3)} ms` : '—'],
          ['Grid + solver allocation estimate', `${((context.memory.totalBytes+(timing?.scratchBytes ?? 0))/1024**2).toFixed(2)} MiB${timing ? '' : ' (solver not yet measured)'}`],
        ].map(([name, value]) => (
          <div key={name}>
            <dt className="text-slate-400">{name}</dt>
            <dd className="mt-1 font-mono text-slate-200">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="text-xs leading-5 text-slate-400">Faster pace advances more actual airflow steps per update; GPU throughput determines elapsed progress. Batch timing includes enabled smoke/tracer work and readback, not rendering FPS. Memory estimates include their calculation buffers, but exclude renderer overhead and do not report total or free VRAM.</p>
      {obstacle.sphere && (
        <ForcePanel sample={stats.forces ?? null} history={forceHistory} />
      )}

      <p className="text-xs leading-5 text-slate-400">
        Density and speed checks cover every fluid cell after each batch. Side,
        top, and bottom boundaries are free-slip; there is no ground friction or
        moving ground. Values use lattice units. The slice displays fluid values
        outside the selected obstacle.
      </p>
        </div>
      </details>
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
