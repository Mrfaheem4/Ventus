export type BoundaryMode =
  | "free-slip"
  | "periodic-sides"
  | "periodic"
  | "channel";
export interface SolverSettings {
  targetSpeed: number;
  tau: number;
  rampSteps: number;
  boundaryMode: BoundaryMode;
  acceleration: number;
}
export const DEFAULT_SETTINGS: SolverSettings = {
  targetSpeed: 0.03,
  tau: 0.6,
  rampSteps: 300,
  boundaryMode: "free-slip",
  acceleration: 0,
};
export function validateSettings(settings: SolverSettings) {
  if (
    !Number.isFinite(settings.targetSpeed) ||
    settings.targetSpeed < 0 ||
    settings.targetSpeed > 0.08
  ) {
    throw new Error("Inlet speed must be between 0 and 0.08 lattice units.");
  }
  if (
    !Number.isFinite(settings.tau) ||
    settings.tau < 0.52 ||
    settings.tau > 2
  ) {
    throw new Error("Relaxation time must be between 0.52 and 2.");
  }
  if (
    !Number.isInteger(settings.rampSteps) ||
    settings.rampSteps < 1 ||
    settings.rampSteps > 10000
  ) {
    throw new Error("Inlet ramp must be between 1 and 10000 steps.");
  }
  if (
    !["free-slip", "periodic-sides", "periodic", "channel"].includes(
      settings.boundaryMode,
    )
  ) {
    throw new Error("Unknown boundary mode.");
  }
  if (
    !Number.isFinite(settings.acceleration) ||
    Math.abs(settings.acceleration) > 1e-4 ||
    (settings.acceleration !== 0 && settings.boundaryMode !== "channel")
  ) {
    throw new Error(
      "Body acceleration must be finite, at most 0.0001 in magnitude, and used only in channel verification mode.",
    );
  }
}
export function inletSpeed(step: number, settings: SolverSettings) {
  if (
    settings.boundaryMode === "periodic" ||
    settings.boundaryMode === "channel"
  )
    return 0;
  const t = Math.min(Math.max(step / settings.rampSteps, 0), 1);
  return settings.targetSpeed * t * t * (3 - 2 * t);
}
