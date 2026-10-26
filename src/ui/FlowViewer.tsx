import { useEffect, useRef, useState } from "react";
import type { GPUContext } from "../gpu/device";
import { colorizeSlice, readSlice } from "../render/slice";
import type { SliceQuantity } from "../render/slice";
import type { TunnelView } from "../render/tunnel-view";
import type { Obstacle } from '../geometry/sphere';
import { obstacleSlice } from '../geometry/sphere';

export function FlowViewer({
  context,
  steps,
  targetSpeed,
  obstacle,
}: {
  context: GPUContext;
  steps: number;
  targetSpeed: number;
  obstacle: Obstacle;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<TunnelView | null>(null);
  const [quantity, setQuantity] = useState<SliceQuantity>("speed");
  const [slice, setSlice] = useState(Math.floor(context.grid.nz / 2));
  const [showGrid, setShowGrid] = useState(false);
  const [showSlice, setShowSlice] = useState(true);
  const [showVoxelBody, setShowVoxelBody] = useState(false);
  const [error, setError] = useState("");
  const [range, setRange] = useState<{
    min: number;
    max: number;
    invalidCells: number;
  } | null>(null);
  const extent = quantity === "speed" ? Math.max(targetSpeed, 0.005) : 0.02;
  const request = useRef({ steps, quantity, slice, extent, showGrid, showSlice, showVoxelBody });

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
      if (!document.hidden && !lost && key !== previous) {
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
      className="overflow-hidden rounded-xl border border-slate-700 bg-slate-950/60"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 p-5">
        <div>
          <h3 id="viewer-heading" className="font-medium text-white">
            3D flow view
          </h3>
          <p className="mt-1 text-xs text-slate-400">
            Drag to orbit · Scroll to zoom · Right-drag to pan
          </p>
        </div>
        <button
          onClick={() => view.current?.resetCamera()}
          className="rounded-lg border border-slate-600 px-3 py-2 text-xs text-slate-200 hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-cyan-400"
        >
          Reset camera
        </button>
      </div>
      <div ref={host} className="h-80 w-full sm:h-96" />
      <div className="space-y-4 p-5">
        <div className="flex flex-wrap items-center gap-5">
          <label className="text-sm text-slate-300">
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
          <label className="flex items-center gap-2 text-sm text-slate-300">
            <input
              type="checkbox"
              checked={showGrid}
              onChange={(event) => setShowGrid(event.target.checked)}
              className="accent-cyan-400"
            />
            Show cell grid
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-300"><input type="checkbox" checked={showSlice} onChange={(event) => setShowSlice(event.target.checked)} className="accent-cyan-400" />Show slice</label>
          {obstacle.sphere && <label className="flex items-center gap-2 text-sm text-slate-300"><input type="checkbox" checked={showVoxelBody} onChange={(event) => setShowVoxelBody(event.target.checked)} className="accent-cyan-400" />Show voxel body</label>}
        </div>
        <div>
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
        <p className="text-xs text-slate-400" data-testid="slice-range">
          {range
            ? `Slice range: ${range.min.toExponential(3)} to ${range.max.toExponential(3)}${range.invalidCells ? ` · ${range.invalidCells} invalid cells shown in magenta` : ""}`
            : "Waiting for the first GPU slice..."}
        </p>
        <p className="text-xs leading-5 text-slate-500">
          Colors come from the simulated field. Values beyond the displayed
          scale use its endpoint color. X follows the wind, Y is up, and Z moves
          the slice. {obstacle.sphere ? 'The smooth sphere is a preview; Show voxel body reveals the solid cells used by the solver. Solid cells are excluded from slice colors and ranges.' : 'The tunnel is empty.'} Streamlines come later.
        </p>
        {error && (
          <p className="rounded-lg border border-amber-400/30 bg-amber-400/10 p-3 text-sm text-amber-200">
            3D view: {error}
          </p>
        )}
      </div>
    </section>
  );
}
