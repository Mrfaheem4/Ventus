import { lazy, Suspense, useEffect, useState } from "react";
import { initializeGPU } from "./gpu/device";
import type { GPUContext } from "./gpu/device";
import { initializeFluid } from "./sim/initialize";
import type { InitializationReport } from "./sim/initialize";
import { SolverPanel } from "./ui/SolverPanel";
import { gridMemory, RESOLUTION_PRESETS } from "./gpu/grid";
import type { Grid } from "./gpu/grid";

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
        setStatus({
          kind: "loading",
          message: "Initializing air at rest and checking GPU samples...",
        });
        const report = await initializeFluid(context, controller.signal);
        if (!controller.signal.aborted)
          setStatus({ kind: "ready", context, report });
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
    <div className="space-y-3">
      <p role="status" className="sr-only">
        GPU ready · Air initialized at rest for startup
      </p>
      {context.fallback && (
        <p className="text-sm text-amber-200">
          A smaller startup grid was selected to fit this GPU.
        </p>
      )}
      <SolverPanel context={context} />
      <details className="mx-3 rounded-lg border border-slate-800 p-3 text-xs text-slate-400">
        <summary className="cursor-pointer">Device diagnostics</summary>
        <div className="mt-3 space-y-3">
          <details className="mx-3 rounded-xl border border-slate-800 p-4">
            <summary className="cursor-pointer text-sm text-slate-400">
              Startup diagnostics
            </summary>
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
                  <dd className="mt-2 text-xl font-medium text-white">
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
            <p className="text-sm leading-6 text-slate-400">
              The tunnel starts with air at rest: density 1.0 in simulation
              units and zero bulk velocity. Use the controls below to start the
              wind.
            </p>
            <section
              aria-labelledby="fluid-heading"
              className="rounded-xl border border-cyan-400/20 bg-cyan-400/5 p-4"
            >
              <h3 id="fluid-heading" className="font-medium text-cyan-200">
                Initial fluid check passed
              </h3>
              <p className="mt-2 text-sm text-slate-300">
                Read back {report.sampledCells} cells from both fluid buffers (
                {report.checkedStates} states). Sampled density:{" "}
                {report.densityMin.toFixed(6)}–{report.densityMax.toFixed(6)}.
                Maximum sampled speed: {report.maxSpeed.toExponential(2)}{" "}
                lattice units.
              </p>
              <p className="mt-2 text-xs text-slate-400">
                Checks cover equilibrium values, density, velocity, and fluid
                flags at selected cells. They do not validate airflow dynamics.
              </p>
            </section>
          </details>
          <details className="mx-3 rounded-xl border border-slate-800 p-4 text-sm text-slate-400">
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
              Memory is an estimate for the core grid resources, excluding
              driver overhead and the small solver parameter and diagnostic
              buffers. GPU limits do not indicate free VRAM. This small grid is
              for development, not validated car aerodynamics.
            </p>
          </details>{" "}
        </div>
      </details>
    </div>
  );
}

function TunnelApp() {
  const [attempt, setAttempt] = useState(0);
  const [resolution, setResolution] = useState("auto");
  const selected = RESOLUTION_PRESETS.find(
    (preset) => preset.id === resolution,
  );
  return (
    <main className="min-h-screen bg-[#080f19]">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-4 py-3 sm:px-6">
        <div className="flex items-center gap-4">
          <h1 className="text-xl font-semibold tracking-tight text-white">
            Ventus<span className="ml-2 text-cyan-400">/</span>
          </h1>
          <span className="text-xs text-slate-400">
            Your GPU powers the wind
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <a
            href="#/import"
            className="rounded-lg border border-cyan-500/40 bg-cyan-400/10 px-4 py-2 text-xs text-cyan-100 hover:bg-cyan-400/20"
          >
            Add your model ↗
          </a>
          <label htmlFor="resolution" className="text-xs text-slate-400">
            Simulation resolution
          </label>
          <select
            id="resolution"
            value={resolution}
            title="Changing resolution resets the flow"
            onChange={(event) => setResolution(event.target.value)}
            className="max-w-52 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-200"
          >
            <option value="auto">Automatic</option>
            {RESOLUTION_PRESETS.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.label} - {preset.grid.nx} x {preset.grid.ny} x{" "}
                {preset.grid.nz} - {mib(gridMemory(preset.grid).totalBytes)}
              </option>
            ))}
          </select>
          <button
            onClick={() => setAttempt((value) => value + 1)}
            className="rounded-lg px-3 py-2 text-xs text-slate-400 hover:bg-slate-800 hover:text-white"
          >
            Reinitialize GPU
          </button>
        </div>
      </header>
      <section aria-label="Wind tunnel workspace">
        <GPUStatus
          key={`${attempt}:${resolution}`}
          requestedGrid={selected?.grid}
        />
      </section>
    </main>
  );
}

const ModelImportPage = lazy(() => import("./ui/ModelImportPage"));
function App() {
  const [page, setPage] = useState(() =>
    location.hash === "#/import" ? "import" : "tunnel",
  );
  useEffect(() => {
    const changed = () =>
      setPage(location.hash === "#/import" ? "import" : "tunnel");
    window.addEventListener("hashchange", changed);
    return () => window.removeEventListener("hashchange", changed);
  }, []);
  return page === "import" ? (
    <Suspense
      fallback={
        <p role="status" className="p-8 text-slate-300">
          Opening model preparation…
        </p>
      }
    >
      <ModelImportPage />
    </Suspense>
  ) : (
    <TunnelApp />
  );
}
export default App;
