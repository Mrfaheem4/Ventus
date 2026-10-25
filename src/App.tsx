import { useEffect, useState } from "react";
import { initializeGPU } from "./gpu/device";
import type { GPUContext } from "./gpu/device";

type Status =
  | { kind: "loading" }
  | { kind: "ready"; context: GPUContext }
  | { kind: "error"; message: string };
const mib = (bytes: number) => `${(bytes / 1024 ** 2).toFixed(2)} MiB`;

function GPUStatus() {
  const [status, setStatus] = useState<Status>({ kind: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    const onFatal = (message: string) => {
      if (!controller.signal.aborted) setStatus({ kind: "error", message });
    };
    void initializeGPU(controller.signal, onFatal)
      .then((context) => {
        if (!controller.signal.aborted) setStatus({ kind: "ready", context });
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
  }, []);

  if (status.kind === "loading")
    return (
      <p role="status" className="mt-4 text-cyan-300">
        Connecting to your GPU and allocating the grid...
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

  const { context } = status;
  const { grid, memory } = context;
  return (
    <div className="mt-5 space-y-6">
      <p role="status" className="text-cyan-300">
        GPU ready · Startup grid allocated
      </p>
      <dl className="grid gap-4 sm:grid-cols-3">
        {[
          ["Grid dimensions", `${grid.nx} × ${grid.ny} × ${grid.nz}`],
          ["Simulation cells", memory.cells.toLocaleString()],
          ["Allocated resource estimate", mib(memory.totalBytes)],
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
        The grid divides the tunnel into small cells. GPU memory is allocated
        and ready for the solver. Airflow calculations have not started.
      </p>
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
          Memory is an estimate for these resources, excluding driver overhead.
          GPU limits do not indicate free VRAM. This small grid is for
          development, not validated car aerodynamics.
        </p>
      </details>
    </div>
  );
}

function App() {
  const [attempt, setAttempt] = useState(0);
  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col justify-center px-6 py-16 sm:px-12">
      <p className="mb-6 text-sm font-medium tracking-[0.25em] text-cyan-400">
        BROWSER-NATIVE WIND TUNNEL
      </p>
      <h1 className="text-6xl font-semibold tracking-tight text-white sm:text-8xl">
        Ventus
      </h1>
      <p className="mt-6 max-w-xl text-lg leading-8 text-slate-400">
        Your device powers the wind tunnel. Start by connecting the GPU and
        preparing space for the airflow simulation.
      </p>
      <section
        aria-labelledby="gpu-heading"
        className="mt-10 rounded-2xl border border-slate-800 bg-slate-900/70 p-6"
      >
        <h2 id="gpu-heading" className="text-lg font-medium text-white">
          GPU foundation
        </h2>
        <GPUStatus key={attempt} />
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
