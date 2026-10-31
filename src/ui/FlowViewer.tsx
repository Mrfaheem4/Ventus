import { useEffect, useRef, useState } from "react";
import type { GPUContext } from "../gpu/device";
import { colorizeSlice, readSlice } from "../render/slice";
import type { SliceQuantity } from "../render/slice";
import type { TunnelView } from "../render/tunnel-view";
import type { Obstacle } from '../geometry/sphere';
import { obstacleSlice } from '../geometry/sphere';
import type { TracerFrame } from '../render/tracer-seeds';
import type { FilamentFrame as SmokeFrame } from '../render/filaments';

export function FlowViewer({
  context,
  steps,
  targetSpeed,
  obstacle,
  tracerFrame,
  tracersEnabled,
  onTracersEnabled,
  tracerBusy,
  tracerError,
  running,
  smokeFrame,
  smokeEnabled,
  onSmokeEnabled,
  smokeError,
}: {
  context: GPUContext;
  steps: number;
  targetSpeed: number;
  obstacle: Obstacle;
  tracerFrame: TracerFrame | null;
  tracersEnabled: boolean;
  onTracersEnabled: (enabled: boolean) => void;
  tracerBusy: boolean;
  tracerError: string;
  running: boolean;
  smokeFrame: SmokeFrame | null;
  smokeEnabled: boolean;
  onSmokeEnabled: (enabled: boolean) => void;
  smokeError: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<TunnelView | null>(null);
  const [quantity, setQuantity] = useState<SliceQuantity>("speed");
  const [slice, setSlice] = useState(Math.floor(context.grid.nz / 2));
  const [showGrid, setShowGrid] = useState(false);
  const [showSlice, setShowSlice] = useState(false);
  const [sliceOpacity, setSliceOpacity] = useState(0.2);
  const [showVoxelBody, setShowVoxelBody] = useState(false);
  const [error, setError] = useState("");
  const [range, setRange] = useState<{
    min: number;
    max: number;
    invalidCells: number;
  } | null>(null);
  const extent = quantity === "speed" ? Math.max(targetSpeed, 0.005) : 0.02;
  const request = useRef({ steps, quantity, slice, extent, showGrid, showSlice, showVoxelBody });
  const tracerRequest = useRef(tracerFrame);
  const smokeRequest = useRef(smokeFrame);
  const runningRequest=useRef(running);
  useEffect(()=>{runningRequest.current=running;view.current?.setRunning(running);},[running]);
  useEffect(() => { tracerRequest.current = tracerFrame; view.current?.setTracers(tracerFrame); },[tracerFrame]);
  useEffect(() => { smokeRequest.current = smokeFrame; view.current?.setSmoke(smokeFrame); },[smokeFrame]);
  useEffect(() => { view.current?.setSliceOpacity(sliceOpacity); },[sliceOpacity]);

  useEffect(() => {
    request.current = { steps, quantity, slice, extent, showGrid, showSlice, showVoxelBody };
  }, [steps, quantity, slice, extent, showGrid, showSlice, showVoxelBody]);
  useEffect(() => {
    view.current?.setGrid(showGrid);
  }, [showGrid]);
  useEffect(() => { view.current?.setSliceVisible(showSlice); }, [showSlice]);
  useEffect(() => { view.current?.setVoxelBody(showVoxelBody); }, [showVoxelBody]);

  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let previous = "";
    let lost = false;
    let active: TunnelView | undefined;
    const onLost = (event: Event) => {
      event.preventDefault();
      lost = true;
      setError(
        "The 3D view lost its graphics connection. Reinitialize the GPU to rebuild the view.",
      );
    };
    async function refresh() {
      if (abort.signal.aborted) return;
      const requested = request.current;
      const key = `${requested.steps}:${requested.quantity}:${requested.slice}:${requested.extent}`;
      if (requested.showSlice && !document.hidden && !lost && key !== previous) {
        try {
          const values = await readSlice(
            context,
            requested.slice,
            abort.signal,
          );
          if (abort.signal.aborted) return;
          const current = request.current;
          if (
            current.quantity === requested.quantity &&
            current.slice === requested.slice &&
            current.extent === requested.extent
          ) {
            const colors = colorizeSlice(
              values,
              requested.quantity,
              requested.extent,
              obstacleSlice(obstacle, context.grid, requested.slice),
            );
            active?.setSlice(requested.slice, colors.pixels);
            setRange({
              min: colors.min,
              max: colors.max,
              invalidCells: colors.invalidCells,
            });
            setError("");
            previous = key;
          }
        } catch (failure) {
          if (!abort.signal.aborted) {
            setError(
              failure instanceof Error
                ? failure.message
                : "The GPU slice could not be read.",
            );
            previous = key;
          }
        }
      }
      if (!abort.signal.aborted)
        timer = setTimeout(() => {
          void refresh();
        }, 120);
    }
    void import("../render/tunnel-view")
      .then(({ createTunnelView }) => {
        if (abort.signal.aborted || !host.current) return;
        active = createTunnelView(host.current, context.grid, obstacle);
        view.current = active;
        active.canvas.addEventListener("webglcontextlost", onLost);
        active.setGrid(request.current.showGrid);
        active.setSliceVisible(request.current.showSlice);
        active.setVoxelBody(request.current.showVoxelBody);
        active.setTracers(tracerRequest.current);
        active.setSmoke(smokeRequest.current);
        active.setRunning(runningRequest.current);
        void refresh();
      })
      .catch((failure: unknown) => {
        if (!abort.signal.aborted)
          setError(
            failure instanceof Error
              ? failure.message
              : "The 3D viewer could not start.",
          );
      });
    return () => {
      abort.abort();
      clearTimeout(timer);
      active?.canvas.removeEventListener("webglcontextlost", onLost);
      active?.dispose();
      view.current = null;
    };
  }, [context, obstacle]);

  return (
    <section
      aria-labelledby="viewer-heading"
      className="overflow-hidden border-y border-slate-800 bg-[#080f19]"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2">
        <div>
          <h3 id="viewer-heading" className="sr-only">
            3D flow view
          </h3>
          <p className="mt-1 text-xs text-slate-400">
            Drag to orbit · Scroll to zoom · Right-drag to pan
          </p>
        </div>
        <div className="flex items-center gap-2">
        <button onClick={() => view.current?.sideView()} className="rounded-lg border border-slate-600 px-3 py-2 text-xs text-slate-200 hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-cyan-400">Side view</button>
        <button
          onClick={() => view.current?.resetCamera()}
          className="rounded-lg border border-slate-600 px-3 py-2 text-xs text-slate-200 hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-cyan-400"
        >
          Reset camera
        </button>
        </div>
      </div>
      <div ref={host} className="h-[55dvh] min-h-80 w-full sm:h-[calc(100dvh-160px)] sm:min-h-[30rem]" />
      <div className="space-y-3 border-t border-slate-800 px-4 py-3">
        <div className="flex flex-wrap items-center gap-5">
          <label hidden={!showSlice} className="text-sm text-slate-300">
            Color by
            <select
              value={quantity}
              onChange={(event) =>
                setQuantity(event.target.value as SliceQuantity)
              }
              className="ml-3 rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-slate-100"
            >
              <option value="speed">Speed</option>
              <option value="pressure">Pressure variation</option>
            </select>
          </label>
          <label hidden={!showSlice} className="flex items-center gap-2 text-sm text-slate-300">
            <input
              type="checkbox"
              checked={showGrid}
              onChange={(event) => setShowGrid(event.target.checked)}
              className="accent-cyan-400"
            />
            Show cell grid
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-300"><input type="checkbox" checked={showSlice} onChange={(event) => setShowSlice(event.target.checked)} className="accent-cyan-400" />Show slice</label>
          <label className="flex items-center gap-2 text-sm text-slate-300"><input type="checkbox" title="Moving wisps illustrate flow along the calculated paths; they do not add physical turbulence." aria-label="Show smoke" checked={smokeEnabled} disabled={tracerBusy} onChange={(event) => onSmokeEnabled(event.target.checked)} className="accent-cyan-400 disabled:opacity-40" />Smoke lines</label>
        </div>
        <details className="text-xs text-slate-400">
          <summary className="cursor-pointer">Inspect geometry and tracers</summary>
          <div className="mt-3 flex flex-wrap gap-5">
          {obstacle.sphere && <label className="flex items-center gap-2 text-sm text-slate-300"><input type="checkbox" checked={showVoxelBody} onChange={(event) => setShowVoxelBody(event.target.checked)} className="accent-cyan-400" />Show voxel body</label>}
          <label className="flex items-center gap-2 text-sm text-slate-300"><input type="checkbox" checked={tracersEnabled} disabled={tracerBusy} onChange={(event) => onTracersEnabled(event.target.checked)} className="accent-cyan-400 disabled:opacity-40" />Show airflow tracers</label>
          </div>
        </details>
        {showSlice && <label className="block text-sm text-slate-300">Slice opacity: {Math.round(sliceOpacity*100)}%<input type="range" min="0.05" max="1" step="0.05" value={sliceOpacity} onChange={(event) => setSliceOpacity(Number(event.target.value))} className="mt-2 w-full accent-cyan-400" /></label>}
        <div hidden={!showSlice}>
          <label htmlFor="slice-z" className="text-sm text-slate-300">
            XY slice position: Z cell {slice + 1} of {context.grid.nz}
          </label>
          <input
            id="slice-z"
            type="range"
            min="0"
            max={context.grid.nz - 1}
            step="1"
            value={slice}
            onChange={(event) => setSlice(Number(event.target.value))}
            className="mt-2 w-full accent-cyan-400"
          />
        </div>
        <div
          hidden={!showSlice}
          aria-label={
            quantity === "speed"
              ? "Speed color scale"
              : "Pressure variation color scale"
          }
        >
          <div
            className="h-2 rounded-full"
            style={{
              background:
                quantity === "speed"
                  ? "linear-gradient(to right, rgb(68,1,84), rgb(59,82,139), rgb(33,145,140), rgb(94,201,98), rgb(253,231,37))"
                  : "linear-gradient(to right, rgb(59,76,192), rgb(221,221,221), rgb(180,4,38))",
            }}
          />
          <div className="mt-2 flex justify-between font-mono text-xs text-slate-400">
            <span>{quantity === "speed" ? "0" : (-extent).toFixed(3)}</span>
            <span>
              {quantity === "speed"
                ? "Speed · cells / step"
                : "Pressure variation · lattice units"}
            </span>
            <span>{extent.toFixed(3)}</span>
          </div>
        </div>
        <p hidden={!showSlice} className="text-xs text-slate-400" data-testid="slice-range">
          {range
            ? `Slice range: ${range.min.toExponential(3)} to ${range.max.toExponential(3)}${range.invalidCells ? ` · ${range.invalidCells} invalid cells shown in magenta` : ""}`
            : "Waiting for the first GPU slice..."}
        </p>
        <p hidden={!showSlice} className="text-xs leading-5 text-slate-500">
          Colors come from the simulated field. Values beyond the displayed
          scale use its endpoint color. X follows the wind, Y is up, and Z moves
          the slice. {obstacle.sphere ? 'Voxels identify the interior; wall intersections follow the curved surface. Solid cells are excluded from slice colors.' : 'The tunnel is empty.'}
        </p>

        {tracerError && <p role="status" className="text-xs text-amber-200">Airflow tracers: {tracerError} The airflow solver can continue with tracers disabled.</p>}
        {smokeError && <p role="status" className="text-xs text-amber-200">Smoke: {smokeError} The airflow solver can continue with smoke disabled.</p>}
        {error && (
          <p className="rounded-lg border border-amber-400/30 bg-amber-400/10 p-3 text-sm text-amber-200">
            3D view: {error}
          </p>
        )}
      </div>
    </section>
  );
}
