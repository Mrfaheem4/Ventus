import type { ForceSample } from "../sim/forces";
import { schillerNaumann } from "../sim/forces";

export function ForcePanel({
  sample,
  history,
}: {
  sample: ForceSample | null;
  history: ForceSample[];
}) {
  const points = history.filter((point) => point.cd !== null);
  const recent = points.filter((point) => point.rampComplete).slice(-50);
  const mean = recent.length
    ? recent.reduce((sum, point) => sum + point.cd!, 0) / recent.length
    : null;
  const reference = sample?.reynolds ? schillerNaumann(sample.reynolds) : null;
  const maximum = Math.max(1, ...points.map((point) => point.cd!));
  const minimum = Math.min(0, ...points.map((point) => point.cd!));
  const first = points[0]?.step ?? 0;
  const last = points.at(-1)?.step ?? 1;
  const line = points
    .map(
      (point) =>
        `${42 + ((point.step - first) / Math.max(last - first, 1)) * 540},${142 - ((point.cd! - minimum) / (maximum - minimum)) * 120}`,
    )
    .join(" ");
  const number = (value: number | null | undefined) =>
    value == null ? "—" : value.toExponential(4);
  return (
    <section
      aria-labelledby="force-heading"
      className="space-y-4 rounded-xl border border-slate-700 bg-slate-900/50 p-4"
    >
      <h3 id="force-heading" className="font-medium text-white">
        Sphere force measurements
      </h3>
      <dl className="grid gap-4 text-sm sm:grid-cols-2">
        {[
          ["Drag force +X (lattice units)", number(sample?.drag)],
          ["Lift force +Y (lattice units)", number(sample?.lift)],
          ["Side force +Z (lattice units)", number(sample?.side)],
          ["Drag coefficient Cd", number(sample?.cd)],
          ["Lift coefficient Cl", number(sample?.cl)],
          ["Recent mean Cd", number(mean)],
        ].map(([name, value]) => (
          <div key={name}>
            <dt className="text-slate-400">{name}</dt>
            <dd className="mt-1 font-mono text-slate-200">{value}</dd>
          </div>
        ))}
      </dl>
      <svg
        viewBox="0 0 600 170"
        className="w-full rounded-lg bg-slate-950/70"
        role="img"
        aria-label="Drag coefficient history"
      >
        <path d="M42 20 V142 H582" stroke="#334155" fill="none" />
        <text x="4" y="26" fill="#94a3b8" fontSize="10">
          {maximum.toPrecision(3)}
        </text>
        <text x="5" y="143" fill="#94a3b8" fontSize="10">
          {minimum.toPrecision(2)}
        </text>
        <text x="42" y="160" fill="#94a3b8" fontSize="10">
          Step {first}
        </text>
        <text x="582" y="160" textAnchor="end" fill="#94a3b8" fontSize="10">
          Step {last}
        </text>
        {points.length > 1 && (
          <polyline
            points={line}
            stroke="#67e8f9"
            strokeWidth="2"
            fill="none"
          />
        )}
        {!points.length && (
          <text x="300" y="82" textAnchor="middle" fill="#94a3b8" fontSize="12">
            Run the flow to collect force samples
          </text>
        )}
      </svg>
      <p className="text-xs leading-5 text-amber-200">
        Provisional measurements.{" "}
        {sample?.rampComplete
          ? "Inlet ramp complete; the flow may still be settling."
          : "The inlet is still ramping up."}{" "}
        A recent mean is not proof of convergence.
      </p>
      <p className="text-xs leading-5 text-slate-400">
        Coefficients use nominal inlet speed, reference density 1, and the
        smooth sphere's projected area. Forces are not in newtons. The chart
        retains up to 600 batch samples; the mean uses up to 50 samples after
        the ramp.
      </p>
      {reference !== null && (
        <p className="text-xs leading-5 text-slate-400">
          Isolated smooth-sphere comparison: Cd ≈ {reference.toFixed(3)} at Re{" "}
          {sample!.reynolds!.toFixed(2)}. Our finite tunnel and voxel surface
          differ from that case; this is not a calibration or validation badge.
        </p>
      )}
    </section>
  );
}
