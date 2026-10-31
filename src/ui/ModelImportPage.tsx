import { Vector3 } from "three";
import { useEffect, useMemo, useRef, useState } from "react";
import { createExampleAsset, loadGlb } from "../models/glb";
import type { PreparedAsset } from "../models/glb";
import { normalizeModel } from "../models/normalization";
import type { ModelRotation } from "../models/normalization";
import type { ModelPreview } from "../render/model-preview";
import "./model-import.css";

function CubeIcon({ size = 24 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="m16 3 12 7v13l-12 7-12-7V10L16 3Z M4 10l12 7 12-7M16 17v13M10 6.5l12 7"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinejoin="round"
      />
    </svg>
  );
}
const dimensions = (values: number[]) =>
  values
    .map((v) =>
      v >= 10 ? v.toFixed(1) : v >= 1 ? v.toFixed(2) : v.toPrecision(3),
    )
    .join(" × ");

export default function ModelImportPage() {
  const [asset, setAsset] = useState<PreparedAsset | null>(null);
  const [rotation, setRotation] = useState<ModelRotation>([0, 0, 0]);
  const [length, setLength] = useState("1");
  const [loading, setLoading] = useState(false),
    [dragging, setDragging] = useState(false);
  const [error, setError] = useState(""),
    [viewError, setViewError] = useState("");
  const [wireframe, setWireframe] = useState(false),
    [reviewed, setReviewed] = useState(false);
  const host = useRef<HTMLDivElement>(null),
    input = useRef<HTMLInputElement>(null),
    view = useRef<ModelPreview | null>(null);
  const generation = useRef({ value: 0 });
  const physicalLength = Number(length);
  const validLength = Number.isFinite(physicalLength) && physicalLength > 0;
  const fit = useMemo(
    () =>
      asset && validLength
        ? normalizeModel(asset.bounds, rotation, physicalLength)
        : null,
    [asset, rotation, physicalLength, validLength],
  );

  const assetRequest = useRef(asset),
    fitRequest = useRef(fit);

  useEffect(() => {
    let cancelled = false;
    const gate = generation.current;
    void import("../render/model-preview")
      .then(({ createModelPreview }) => {
        if (!cancelled && host.current) {
          view.current = createModelPreview(host.current);
          view.current.setModel(
            assetRequest.current,
            fitRequest.current ?? undefined,
          );
        }
      })
      .catch((e: unknown) => {
        if (!cancelled)
          setViewError(
            e instanceof Error ? e.message : "The 3D preview could not start.",
          );
      });
    return () => {
      cancelled = true;
      gate.value++;
      view.current?.dispose();
      view.current = null;
    };
  }, []);
  useEffect(() => {
    assetRequest.current = asset;
    const preview = view.current;
    preview?.setModel(
      asset,
      asset
        ? normalizeModel(
            asset.bounds,
            [0, 0, 0],
            Math.max(...asset.bounds.getSize(new Vector3()).toArray()),
          )
        : undefined,
    );
    return () => {
      view.current?.setModel(null);
      asset?.dispose();
    };
  }, [asset]);
  useEffect(() => {
    fitRequest.current = fit;
    if (fit) view.current?.place(fit);
  }, [fit]);
  useEffect(() => {
    view.current?.setWireframe(wireframe);
  }, [wireframe]);

  function accept(model: PreparedAsset) {
    setAsset(model);
    setRotation([0, 0, 0]);
    setLength(
      String(
        Number(
          Math.max(
            ...model.bounds.getSize(new Vector3()).toArray(),
          ).toPrecision(6),
        ),
      ),
    );
    setReviewed(false);
    setError("");
    setWireframe(false);
  }
  async function open(file: File) {
    if (loading) return;
    const request = ++generation.current.value;
    setLoading(true);
    setError("");
    try {
      const model = await loadGlb(file);
      if (request !== generation.current.value) {
        model.dispose();
        return;
      }
      accept(model);
    } catch (e) {
      if (request === generation.current.value)
        setError(
          e instanceof Error ? e.message : "The model could not be opened.",
        );
    } finally {
      if (request === generation.current.value) setLoading(false);
    }
  }
  function rotate(axis: number) {
    setRotation(
      (previous) =>
        previous.map((angle, i) =>
          i === axis ? (angle + 90) % 360 : angle,
        ) as unknown as ModelRotation,
    );
    setReviewed(false);
  }
  function clear() {
    generation.current.value++;
    setAsset(null);
    setError("");
    setReviewed(false);
    setRotation([0, 0, 0]);
  }

  return (
    <main className="model-page">
      <header className="model-header">
        <a className="model-brand" href="#/tunnel">
          ventus<span>/</span>
          <small>WIND LAB</small>
        </a>
        <nav aria-label="Preparation steps">
          <span className={!asset ? "current" : ""}>
            <b>01</b> Import
          </span>
          <i />
          <span className={asset ? "current" : ""}>
            <b>02</b> Prepare
          </span>
          <i />
          <span className="muted">
            <b>03</b> Simulate
          </span>
        </nav>
        <a className="model-lab-link" href="#/tunnel">
          Sphere lab <span>↗</span>
        </a>
      </header>
      <div className="model-intro">
        <div>
          <p className="model-eyebrow">
            <span /> MODEL PREPARATION
          </p>
          <h1>
            Bring your model into the tunnel<span>.</span>
          </h1>
          <p>
            A considered setup starts with the right scale. Import, orient, and
            find your fit.
          </p>
        </div>
        <div className="model-local">
          <span>◈</span>
          <div>
            Private by design<small>Your file stays on this device.</small>
          </div>
        </div>
      </div>
      <div className="model-workspace">
        <aside className="model-sidebar">
          <section className="model-panel">
            <div className="model-panel-title">
              <span>01 / SOURCE</span>
              {asset && (
                <button onClick={clear} disabled={loading}>
                  Clear
                </button>
              )}
            </div>
            <input
              ref={input}
              type="file"
              accept=".glb,model/gltf-binary"
              aria-label="Upload GLB model"
              tabIndex={-1}
              className="model-file-input"
              disabled={loading}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void open(file);
                event.target.value = "";
              }}
            />
            <div
              className={`model-drop ${dragging ? "dragging" : ""} ${asset ? "has-model" : ""}`}
              onDragOver={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => {
                event.preventDefault();
                setDragging(false);
                const files = event.dataTransfer.files;
                if (files.length === 1) void open(files[0]);
                else setError("Choose one GLB file at a time.");
              }}
            >
              <div className="model-drop-icon">
                <CubeIcon size={34} />
                <span>+</span>
              </div>
              <h2>
                {loading
                  ? "Opening your model…"
                  : asset
                    ? "A new shape to explore"
                    : "Drop your GLB here"}
              </h2>
              <p>
                {loading
                  ? "Reading geometry and embedded materials."
                  : "Self-contained .glb · up to 50 MB"}
              </p>
              <button
                className="model-choose"
                disabled={loading}
                onClick={() => input.current?.click()}
              >
                {loading
                  ? "Opening…"
                  : asset
                    ? "Replace model"
                    : "Choose GLB file"}
                <span>↗</span>
              </button>
            </div>
            {error && (
              <p className="model-error" role="alert">
                {error}
              </p>
            )}
            {asset ? (
              <div className="model-file-card">
                <CubeIcon size={22} />
                <div>
                  <strong title={asset.name}>{asset.name}</strong>
                  <small>
                    {asset.bytes
                      ? `${(asset.bytes / 1024 / 1024).toFixed(2)} MB`
                      : "Built-in example"}{" "}
                    · {asset.meshes} meshes
                  </small>
                </div>
                <span className="model-check">✓</span>
              </div>
            ) : (
              <button
                className="model-example"
                disabled={loading}
                onClick={() => accept(createExampleAsset())}
              >
                Just exploring? <span>Try the reference model →</span>
              </button>
            )}
          </section>
          <section
            className={`model-panel model-settings ${asset ? "" : "inactive"}`}
          >
            <div className="model-panel-title">
              <span>02 / SCALE & ORIENTATION</span>
              <span className="model-tiny-tag">UNIFORM FIT</span>
            </div>
            <fieldset disabled={!asset || loading}>
              <label className="model-label" htmlFor="physical-length">
                Physical longest dimension <span>metres</span>
              </label>
              <div className="model-length">
                <input
                  id="physical-length"
                  type="number"
                  min="0.000001"
                  step="any"
                  value={length}
                  onChange={(event) => {
                    setLength(event.target.value);
                    setReviewed(false);
                  }}
                />
                <span>m</span>
              </div>
              {asset && !validLength && (
                <p role="alert" className="model-error">
                  Enter a length greater than zero.
                </p>
              )}
              <p className="model-help">
                Confirm the real-world size. Proportions stay intact.
              </p>
              <div className="model-label model-rotation-label">
                Rotate model{" "}
                <button
                  onClick={() => {
                    setRotation([0, 0, 0]);
                    setReviewed(false);
                  }}
                >
                  Reset
                </button>
              </div>
              <div className="model-rotation">
                {["X", "Y", "Z"].map((axis, i) => (
                  <button
                    key={axis}
                    onClick={() => rotate(i)}
                    aria-label={`Rotate ${axis} 90 degrees`}
                  >
                    <span>
                      {axis}
                      <sup>↻</sup>
                    </span>
                    <small>{rotation[i]}°</small>
                  </button>
                ))}
              </div>
            </fieldset>
            <div className="model-dimensions">
              <span>
                PREPARED ENVELOPE <small>X × Y × Z</small>
              </span>
              <strong data-testid="physical-dimensions">
                {fit ? dimensions(fit.physicalSize.toArray()) : "— × — × —"}
                <small> m</small>
              </strong>
              <p>
                {asset
                  ? `${asset.triangles.toLocaleString()} triangles · original proportions preserved`
                  : "Upload a model to inspect its dimensions."}
              </p>
            </div>
          </section>
          <div className="model-submit">
            <button
              className="model-primary"
              disabled={!fit || loading || Boolean(viewError)}
              onClick={() => {
                setReviewed(true);
                view.current?.resetCamera();
              }}
            >
              Review placement <span>→</span>
            </button>
            <p>Preparation only. Airflow geometry checks come next.</p>
          </div>
        </aside>
        <section className="model-stage" aria-label="Model preparation preview">
          <div className="model-stage-bar">
            <span>
              <i /> {asset ? "YOUR MODEL" : "REFERENCE PREVIEW"}
            </span>
            <div>
              <button
                className={wireframe ? "active" : ""}
                aria-pressed={wireframe}
                onClick={() => setWireframe((value) => !value)}
              >
                Wireframe
              </button>
              <button onClick={() => view.current?.resetCamera()}>
                Reset view ↗
              </button>
            </div>
          </div>
          <div ref={host} className="model-canvas" />
          {viewError && (
            <p className="model-preview-error" role="alert">
              {viewError}
            </p>
          )}
          <div className="model-stage-side">
            FREE 3D INSPECTION <span>DRAG TO ORBIT · SCROLL TO ZOOM</span>
          </div>
          <div className="model-stage-bottom">
            <div className="model-direction">
              <span>+</span>
              <i />
              <b>X</b>
              <small>WIND DIRECTION</small>
            </div>
            <span>
              {asset ? asset.name : "Reference coupe / upload to replace"}
            </span>
          </div>
          <div className="model-scale-note">
            <span>AUTO-FIT</span>
            <strong>{fit ? `${fit.scale.toPrecision(3)}×` : "—"}</strong>
            <small>Display scale</small>
          </div>
        </section>
      </div>
      <footer className="model-bottom">
        <div>
          <span className="model-status-dot" />
          <p>
            {reviewed
              ? "Placement prepared"
              : asset
                ? "Model imported. Fine-tune its placement."
                : "Your next experiment starts with a model."}
            <small>
              {reviewed
                ? "The visible model and future voxelisation will use the same transform."
                : "Models are centred and scaled equally on all axes, with clearance around the body."}
            </small>
          </p>
        </div>
        <span className="model-geometry-status">
          SOLID VOLUME <b>Not checked yet</b>
        </span>
      </footer>
      {asset?.notes.map((note) => (
        <p className="model-note" key={note}>
          {note}
        </p>
      ))}
    </main>
  );
}
