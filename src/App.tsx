import { useEffect, useState } from 'react'

function App() {
  const [gpuStatus, setGpuStatus] = useState('Checking WebGPU availability…')

  useEffect(() => {
    let active = true

    async function checkWebGPU() {
      if (!window.isSecureContext || !navigator.gpu) {
        setGpuStatus('WebGPU unavailable. Use a compatible browser on HTTPS or localhost.')
        return
      }

      try {
        const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
        if (active) {
          setGpuStatus(adapter ? 'WebGPU adapter available' : 'No compatible WebGPU adapter found')
        }
      } catch {
        if (active) setGpuStatus('WebGPU adapter check failed. Check your browser and GPU settings.')
      }
    }

    void checkWebGPU()
    return () => { active = false }
  }, [])

  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col justify-center px-6 py-16 sm:px-12">
      <p className="mb-6 text-sm font-medium tracking-[0.25em] text-cyan-400">BROWSER-NATIVE WIND TUNNEL</p>
      <h1 className="text-6xl font-semibold tracking-tight text-white sm:text-8xl">Ventus</h1>
      <p className="mt-6 max-w-xl text-lg leading-8 text-slate-400">
        A foundation for real-time airflow simulation with React, TypeScript, and WebGPU.
      </p>
      <div className="mt-10 rounded-2xl border border-slate-800 bg-slate-900/70 p-6">
        <h2 className="text-lg font-medium text-white">Development environment ready</h2>
        <p role="status" className="mt-3 text-sm text-cyan-300">{gpuStatus}</p>
        <p className="mt-4 text-sm leading-6 text-slate-400">
          Tailwind CSS is configured. Three.js model loaders and camera controls are installed.
          The LBM solver, voxelization, and flow visualization are planned in the README.
        </p>
      </div>
      <p className="mt-6 text-xs text-slate-500">Pre-alpha · Simulation is not implemented yet</p>
    </main>
  )
}

export default App
