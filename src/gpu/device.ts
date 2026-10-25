import { allocateGrid } from "./buffers";
import { fitsGrid, gridMemory, STARTER_GRIDS } from "./grid";

export async function initializeGPU(
  signal: AbortSignal,
  onFatal: (message: string) => void,
) {
  if (!window.isSecureContext) {
    throw new Error(
      "WebGPU needs a secure connection. Open Ventus on localhost or HTTPS.",
    );
  }
  if (!navigator.gpu) {
    throw new Error(
      "WebGPU is unavailable. Try an updated Chrome or Edge browser with hardware acceleration enabled.",
    );
  }
  const adapter = await navigator.gpu.requestAdapter({
    powerPreference: "high-performance",
  });
  signal.throwIfAborted();
  if (!adapter)
    throw new Error(
      "No compatible GPU adapter was found. Check browser hardware acceleration and GPU drivers.",
    );
  const candidates = STARTER_GRIDS.filter((grid) =>
    fitsGrid(grid, adapter.limits),
  );
  if (!candidates.length)
    throw new Error("This GPU cannot fit the smallest supported startup grid.");

  const device = await adapter.requestDevice({
    label: "Ventus simulation device",
    requiredFeatures: adapter.features.has("timestamp-query")
      ? ["timestamp-query"]
      : [],
  });
  let disposed = false;
  let resources: ReturnType<typeof allocateGrid> | undefined;
  function dispose() {
    if (disposed) return;
    disposed = true;
    signal.removeEventListener("abort", dispose);
    resources?.destroy();
    device.destroy();
  }
  function fail(message: string) {
    if (disposed) return;
    dispose();
    onFatal(message);
  }
  signal.addEventListener("abort", dispose, { once: true });
  void device.lost.then((info) => {
    fail(
      `GPU connection lost${info.message ? `: ${info.message}` : "."} Reinitialize to reconnect.`,
    );
  });
  device.addEventListener("uncapturederror", (event) => {
    event.preventDefault();
    fail(`GPU error: ${event.error.message}. Reinitialize to try again.`);
  });

  try {
    signal.throwIfAborted();
    for (const grid of candidates) {
      device.pushErrorScope("out-of-memory");
      device.pushErrorScope("internal");
      device.pushErrorScope("validation");
      let allocationError: unknown;
      try {
        resources = allocateGrid(device, grid);
      } catch (error) {
        allocationError = error;
      }
      // Pop every scope; validation errors must not be disguised as memory issues.
      const validation = await device.popErrorScope();
      const internal = await device.popErrorScope();
      const outOfMemory = await device.popErrorScope();
      signal.throwIfAborted();
      if (disposed)
        throw new Error(
          "GPU connection was lost during initialization. Reinitialize to try again.",
        );
      if (validation || internal || allocationError) {
        throw new Error(
          validation?.message ??
            internal?.message ??
            (allocationError instanceof Error
              ? allocationError.message
              : "GPU allocation failed."),
        );
      }
      if (outOfMemory) {
        resources?.destroy();
        resources = undefined;
        continue;
      }
      return {
        device,
        resources: resources!,
        grid,
        memory: gridMemory(grid),
        dispose,
        adapterName:
          adapter.info.description ||
          adapter.info.device ||
          adapter.info.vendor ||
          "Browser-managed GPU",
        timestampQueries: device.features.has("timestamp-query"),
        fallback: grid !== STARTER_GRIDS[0],
        limits: {
          maxBufferSize: device.limits.maxBufferSize,
          maxStorageBufferBindingSize:
            device.limits.maxStorageBufferBindingSize,
          maxTextureDimension3D: device.limits.maxTextureDimension3D,
        },
      };
    }
    throw new Error(
      "Not enough GPU memory for a startup grid. Close GPU-heavy applications and try again.",
    );
  } catch (error) {
    dispose();
    throw error;
  }
}

export type GPUContext = Awaited<ReturnType<typeof initializeGPU>>;
