/// <reference types="@webgpu/types" />
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { fitsGrid, gridMemory, STARTER_GRIDS } from "../src/gpu/grid";

declare global {
  interface Window {
    gpuTest: {
      activeResources: number;
      activeDevices: number;
      lose: () => void;
    };
  }
}

async function mockGPU(
  page: Page,
  mode:
    | "ready"
    | "no-adapter"
    | "low-limits"
    | "oom"
    | "validation"
    | "bad-initialization"
    | "request-failure" = "ready",
) {
  await page.addInitScript((mode) => {
    const state = {
      activeResources: 0,
      activeDevices: 0,
      lose: () => {
        throw new Error("No device");
      },
    };
    window.gpuTest = state;
    const limits = {
      maxBufferSize: 268435456,
      maxStorageBufferBindingSize: mode === "low-limits" ? 1048576 : 134217728,
      maxTextureDimension3D: 2048,
    };
    Object.defineProperty(navigator, "gpu", {
      configurable: true,
      value: {
        requestAdapter: async () =>
          mode === "no-adapter"
            ? null
            : {
                limits,
                features: new Set(),
                info: { description: "Test GPU" },
                requestDevice: async () => {
                  if (mode === "request-failure")
                    throw new Error("Device request rejected");
                  state.activeDevices++;
                  let resolveLost: (info: {
                    message: string;
                    reason: string;
                  }) => void;
                  const lost = new Promise((resolve) => {
                    resolveLost = resolve;
                  });
                  state.lose = () =>
                    resolveLost({
                      message: "Test disconnect",
                      reason: "unknown",
                    });
                  let destroyed = false;
                  let oomReported = false;
                  const scopes: string[] = [];
                  const resource = (descriptor: { size?: number }) => {
                    state.activeResources++;
                    let released = false;
                    return {
                      createView: () => ({}),
                      mapAsync: async () => undefined,
                      unmap: () => undefined,
                      // Lifecycle-only test double. Real shader correctness is tested
                      // separately on a real adapter in initialization.spec.ts.
                      getMappedRange: () => {
                        const data = new Float32Array((descriptor.size ?? 0) / 4);
                        for (let sample = 0; sample < data.length / 39; sample++) {
                          for (let state = 0; state < 2; state++) {
                            for (let i = 0; i < 19; i++) {
                              data[sample * 39 + state * 19 + i] = i === 0 ? 1 / 3 : i <= 6 ? 1 / 18 : 1 / 36;
                            }
                          }
                        }
                        if (mode === "bad-initialization") data[0] = NaN;
                        return data.buffer;
                      },
                      destroy: () => {
                        if (!released) {
                          released = true;
                          state.activeResources--;
                        }
                      },
                    };
                  };
                  return Object.assign(new EventTarget(), {
                    limits,
                    features: new Set(),
                    lost,
                    createBuffer: resource,
                    createTexture: resource,
                    createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [] }) }),
                    createComputePipelineAsync: async () => ({ getBindGroupLayout: () => ({}) }),
                    createBindGroup: () => ({}),
                    queue: { writeBuffer: () => undefined, submit: () => undefined },
                    createCommandEncoder: () => ({
                      beginComputePass: () => ({
                        setPipeline: () => undefined, setBindGroup: () => undefined,
                        dispatchWorkgroups: () => undefined, end: () => undefined,
                      }),
                      copyBufferToBuffer: () => undefined,
                      finish: () => ({}),
                    }),
                    pushErrorScope: (scope: string) => scopes.push(scope),
                    popErrorScope: async () => {
                      const scope = scopes.pop();
                      if (mode === "validation" && scope === "validation")
                        return { message: "Invalid resource descriptor" };
                      if (
                        mode === "oom" &&
                        scope === "out-of-memory" &&
                        !oomReported
                      ) {
                        oomReported = true;
                        return { message: "Out of memory" };
                      }
                      return null;
                    },
                    destroy: () => {
                      if (!destroyed) {
                        destroyed = true;
                        state.activeDevices--;
                        resolveLost({ message: "", reason: "destroyed" });
                      }
                    },
                  });
                },
              },
      },
    });
  }, mode);
}

test("startup memory estimate includes both distributions, flags, field and parameters", () => {
  const memory = gridMemory(STARTER_GRIDS[0]);
  expect(memory.cells).toBe(65536);
  expect(memory.distributionBytes).toBe(4980736);
  expect(memory.totalBytes).toBe(10747936);
  expect(
    fitsGrid(STARTER_GRIDS[0], {
      maxBufferSize: 268435456,
      maxStorageBufferBindingSize: 1048576,
      maxTextureDimension3D: 2048,
    }),
  ).toBe(false);
  expect(
    fitsGrid(STARTER_GRIDS[0], {
      maxBufferSize: 268435456,
      maxStorageBufferBindingSize: 134217728,
      maxTextureDimension3D: 32,
    }),
  ).toBe(false);
});

test("unsupported WebGPU shows guidance", async ({ page }) => {
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "gpu", { value: undefined }),
  );
  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText("WebGPU is unavailable");
});

test("no adapter shows a useful message", async ({ page }) => {
  await mockGPU(page, "no-adapter");
  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText(
    "No compatible GPU adapter",
  );
});

test("allocates the grid and releases old resources on reinitialization", async ({
  page,
}) => {
  await mockGPU(page);
  await page.goto("/");
  await expect(page.getByRole("status")).toContainText("GPU ready");
  await expect(page.getByText("64 × 32 × 32")).toBeVisible();
  await page.getByRole("button", { name: "Reinitialize GPU" }).click();
  await expect(page.getByRole("status")).toContainText("GPU ready");
  expect(
    await page.evaluate(() => [
      window.gpuTest.activeDevices,
      window.gpuTest.activeResources,
    ]),
  ).toEqual([1, 5]);
});

for (const mode of ["low-limits", "oom"] as const) {
  test(`falls back to a smaller grid for ${mode}`, async ({ page }) => {
    await mockGPU(page, mode);
    await page.goto("/");
    await expect(page.getByRole("status")).toContainText("GPU ready");
    await expect(page.getByText("32 × 16 × 16")).toBeVisible();
    expect(await page.evaluate(() => window.gpuTest.activeResources)).toBe(5);
  });
}

test("device loss releases resources and permits recovery", async ({
  page,
}) => {
  await mockGPU(page);
  await page.goto("/");
  await expect(page.getByRole("status")).toContainText("GPU ready");
  await page.evaluate(() => window.gpuTest.lose());
  await expect(page.getByRole("alert")).toContainText("GPU connection lost");
  expect(
    await page.evaluate(() => [
      window.gpuTest.activeDevices,
      window.gpuTest.activeResources,
    ]),
  ).toEqual([0, 0]);
  await page.getByRole("button", { name: "Reinitialize GPU" }).click();
  await expect(page.getByRole("status")).toContainText("GPU ready");
});

for (const mode of ["validation", "request-failure"] as const) {
  test(`surfaces ${mode} errors without retaining resources`, async ({
    page,
  }) => {
    await mockGPU(page, mode);
    await page.goto("/");
    await expect(page.getByRole("alert")).toContainText(
      mode === "validation"
        ? "Invalid resource descriptor"
        : "Device request rejected",
    );
    expect(
      await page.evaluate(() => [
        window.gpuTest.activeDevices,
        window.gpuTest.activeResources,
      ]),
    ).toEqual([0, 0]);
  });
}

test("real browser initializes resources when a WebGPU adapter is available", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("status").or(page.getByRole("alert")),
  ).not.toContainText("Connecting");
  const supported = await page.evaluate(async () =>
    Boolean(navigator.gpu && (await navigator.gpu.requestAdapter())),
  );
  test.skip(
    !supported,
    "This browser environment has no WebGPU adapter; failure paths are tested separately.",
  );
  await expect(page.getByRole("status")).toContainText("GPU ready");
  await expect(page.getByRole("heading", { name: "Initial fluid check passed" })).toBeVisible();
  await page.screenshot({
    path: "test-results/gpu-foundation.png",
    fullPage: true,
  });
});

test("invalid initialized populations show an error and release resources", async ({ page }) => {
  await mockGPU(page, "bad-initialization");
  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText("invalid distribution");
  expect(await page.evaluate(() => [window.gpuTest.activeDevices, window.gpuTest.activeResources])).toEqual([0, 0]);
});
