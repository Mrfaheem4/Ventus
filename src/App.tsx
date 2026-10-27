import { useEffect, useState } from "react";
import { initializeGPU } from "./gpu/device";
import type { GPUContext } from "./gpu/device";
import { initializeFluid } from "./sim/initialize";
import type { InitializationReport } from "./sim/initialize";
import { SolverPanel } from "./ui/SolverPanel";
import { gridMemory, RESOLUTION_PRESETS } from './gpu/grid';
import type { Grid } from './gpu/grid';

type Status =
  | { kind: "loading"; message?: string }
  | { kind: "ready"; context: GPUContext; report: InitializationReport }
  | { kind: "error"; message: string };
const mib = (bytes: number) => `${(bytes / 1024 ** 2).toFixed(2)} MiB`;

function GPUStatus({ requestedGrid }: { requestedGrid?: Grid }) {
  const [status, setStatus] = useState<Status>({ kind: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    const onFatal = (message: string) => {
      if (!controller.signal.aborted) {
        controller.abort();
        setStatus({ kind: "error", message });
      }
    };
    void initializeGPU(controller.signal, onFatal, requestedGrid)
      .then(async (context) => {
        if (controller.signal.aborted) return;
        setStatus({ kind: "loading", message: "Initializing air at rest and checking GPU samples..." });
        const report = await initializeFluid(context, controller.signal);
        if (!controller.signal.aborted) setStatus({ kind: "ready", context, report });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          onFatal(
            error instanceof Error
              ? error.message
              : "GPU initialization failed.",
          );
        }
      });
    return () => controller.abort();
  }, [requestedGrid]);

  if (status.kind === "loading")
    return (
      <p role="status" className="mt-4 text-cyan-300">
        {status.message ?? "Connecting to your GPU and allocating the grid..."}
      </p>
    );
  if (status.kind === "error")
    return (
      <p
        role="alert"
        className="mt-4 rounded-xl border border-amber-400/30 bg-amber-400/10 p-4 text-amber-200"
      >
        {status.message}
      </p>
    );

  const { context, report } = status;
  const { grid, memory } = context;
  return (
    <div className="mt-5 space-y-6">
      <p role="status" className="text-cyan-300">
        GPU ready · Air initialized at rest for startup
      </p>
      <SolverPanel context={context} />
      <details className="rounded-xl border border-slate-800 p-4"><summary className="cursor-pointer text-sm text-slate-400">Startup diagnostics</summary>
      <dl className="grid gap-4 sm:grid-cols-3">
        {[
          ["Grid dimensions", `${grid.nx} × ${grid.ny} × ${grid.nz}`],
          ["Simulation cells", memory.cells.toLocaleString()],
          ["Core grid memory estimate", mib(memory.totalBytes)],
        ].map(([label, value]) => (
          <div
            key={label}
            className="rounded-xl border border-slate-700 bg-slate-950/60 p-4"
          >
            <dt className="text-sm text-slate-400">{label}</dt>
            <dd className="mt-2 text-xl font-medium text-white">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="text-sm leading-6 text-slate-400">
        The tunnel starts with air at rest: density 1.0 in simulation units and
        zero bulk velocity. Use the controls below to start the wind.
      </p>
      <section aria-labelledby="fluid-heading" className="rounded-xl border border-cyan-400/20 bg-cyan-400/5 p-4">
        <h3 id="fluid-heading" className="font-medium text-cyan-200">Initial fluid check passed</h3>
        <p className="mt-2 text-sm text-slate-300">
          Read back {report.sampledCells} cells from both fluid buffers ({report.checkedStates} states).
          Sampled density: {report.densityMin.toFixed(6)}–{report.densityMax.toFixed(6)}.
          Maximum sampled speed: {report.maxSpeed.toExponential(2)} lattice units.
        </p>
        <p className="mt-2 text-xs text-slate-400">
          Checks cover equilibrium values, density, velocity, and fluid flags at selected cells.
          They do not validate airflow dynamics.
        </p>
      </section>
      </details>

      {context.fallback && (
        <p className="text-sm text-amber-200">
          A smaller startup grid was selected to fit this GPU.
        </p>
      )}
      <details className="rounded-xl border border-slate-800 p-4 text-sm text-slate-400">
        <summary className="cursor-pointer text-slate-200">
          GPU and memory details
        </summary>
        <dl className="mt-4 grid gap-x-6 gap-y-2 sm:grid-cols-2">
          {[
            ["Adapter", context.adapterName],
            [
              "Timestamp queries",
              context.timestampQueries ? "Available" : "Unavailable",
            ],
            ["Each distribution buffer", mib(memory.distributionBytes)],
            ["Cell flags", mib(memory.flagsBytes)],
            ["Velocity / pressure texture", mib(memory.fieldBytes)],
            ["Maximum buffer size", mib(context.limits.maxBufferSize)],
            [
              "Maximum storage binding",
              mib(context.limits.maxStorageBufferBindingSize),
            ],
            [
              "Maximum 3D texture dimension",
              String(context.limits.maxTextureDimension3D),
            ],
          ].map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd className="text-slate-200">{value}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-4">
          Memory is an estimate for the core grid resources, excluding driver overhead
          and the small solver parameter and diagnostic buffers.
          GPU limits do not indicate free VRAM. This small grid is for
          development, not validated car aerodynamics.
        </p>
      </details>
    </div>
  );
}

function App() {
  const [attempt, setAttempt] = useState(0);
  const [resolution, setResolution] = useState('auto');
  const selected = RESOLUTION_PRESETS.find((preset) => preset.id === resolution);
  return (
    <main className="mx-auto flex min-h-screen max-w-[1600px] flex-col px-4 py-6 sm:px-8">
      <p className="mb-2 text-xs font-medium tracking-[0.25em] text-cyan-400">
        BROWSER-NATIVE WIND TUNNEL
      </p>
      <h1 className="text-3xl font-semibold tracking-tight text-white">
        Ventus
      </h1>
      <p className="mt-2 max-w-xl text-sm leading-6 text-slate-400">
        Your GPU powers this wind tunnel. Set the wind, run, and explore the flow.
      </p>
      <section
        aria-labelledby="gpu-heading"
        className="mt-5 rounded-2xl border border-slate-800 bg-slate-900/70 p-6"
      >
        <h2 id="gpu-heading" className="text-lg font-medium text-white">
          GPU and airflow solver
        </h2>
        <div className="mt-5 space-y-2">
          <label className="block text-sm text-slate-300" htmlFor="resolution">Simulation resolution</label>
          <select id="resolution" value={resolution} onChange={(event) => setResolution(event.target.value)} className="rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-slate-200">
            <option value="auto">Automatic — conservative startup</option>
            {RESOLUTION_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.label} — {preset.grid.nx} × {preset.grid.ny} × {preset.grid.nz} · {mib(gridMemory(preset.grid).totalBytes)}</option>)}
          </select>
          <p className="text-xs leading-5 text-slate-400">Your GPU runs the simulation. Higher resolution resolves smaller features and needs more memory and calculation. Changing resolution resets the flow, history, and wind settings. Estimates exclude renderer and driver overhead.</p>
        </div>
        <GPUStatus key={`${attempt}:${resolution}`} requestedGrid={selected?.grid} />
        <button
          onClick={() => setAttempt((value) => value + 1)}
          className="mt-6 rounded-lg border border-cyan-400/40 px-4 py-2 text-sm text-cyan-200 hover:bg-cyan-400/10 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-cyan-400"
        >
          Reinitialize GPU
        </button>
      </section>
      <p className="mt-6 text-xs text-slate-500">
        Pre-alpha · Static models · Local GPU computation
      </p>
    </main>
  );
}

export default App;
