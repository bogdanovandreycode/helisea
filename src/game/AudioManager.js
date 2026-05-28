import { AUDIO } from './assets.js'

/**
 * Thin wrapper around HTML5 Audio.
 * Audio cannot start until after the first user gesture;
 * call enable() on first click / pointer-lock.
 */
export class AudioManager {
  constructor() {
    this._enabled = false
    this._urls    = {}
    this._loops   = {}   // name → HTMLAudioElement (looping)
    this._ctx     = null
    this._loopBuffers = {}  // name -> AudioBuffer
    this._loopGains   = {}  // name -> GainNode
    this._loopSources = {}  // name -> AudioBufferSourceNode
    this._loopPending = {}  // name -> boolean
  }

  /** Pre-resolve all URL references (instant, no network). */
  init() {
    this._urls = { ...AUDIO }
  }

  /** Call after first user gesture. */
  enable() {
    if (this._enabled) return
    this._enabled = true

    // WebAudio is used for seamless loops (no gap between repeats).
    if (!this._ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext
      if (Ctx) this._ctx = new Ctx()
    }
    if (this._ctx && this._ctx.state === 'suspended') {
      this._ctx.resume().catch(() => {})
    }
  }

  /** Play a one-shot sound. */
  play(name, volume = 1.0) {
    if (!this._enabled) return
    const url = this._urls[name]
    if (!url) return
    const a = new Audio(url)
    a.volume = Math.min(1, Math.max(0, volume))
    a.play().catch(() => {})
  }

  /**
   * Play a positional one-shot sound. Volume fades to zero at maxDist.
   * @param {string} name
   * @param {THREE.Vector3} sourcePos
   * @param {THREE.Vector3} listenerPos
   * @param {number} maxDist
   * @param {number} baseVol
   */
  play3D(name, sourcePos, listenerPos, maxDist = 300, baseVol = 1.0) {
    if (!this._enabled) return
    const dist = sourcePos.distanceTo(listenerPos)
    const vol = baseVol * Math.max(0, 1 - dist / maxDist)
    if (vol > 0.005) this.play(name, vol)
  }

  /** Start a looping ambient sound (once). */
  startLoop(name, volume = 0.5) {
    const clampedVolume = Math.min(1, Math.max(0, volume))

    // Already playing via WebAudio.
    if (this._loopSources[name]) {
      const g = this._loopGains[name]
      if (g) g.gain.value = clampedVolume
      return
    }

    // Loop is being created asynchronously.
    if (this._loopPending[name]) return

    // Try seamless WebAudio path first.
    if (this._enabled && this._ctx) {
      this._loopPending[name] = true
      this._startLoopWebAudio(name, clampedVolume)
        .catch(() => {
          // Fallback to HTMLAudio loop if WebAudio fails.
          this._startLoopHtml(name, clampedVolume)
        })
        .finally(() => {
          this._loopPending[name] = false
        })
      return
    }

    // Pre-gesture fallback (kept for compatibility with existing flow).
    this._startLoopHtml(name, clampedVolume)
  }

  _startLoopHtml(name, volume) {
    if (this._loops[name]) return
    const url = this._urls[name]
    if (!url) return
    const a = new Audio(url)
    a.loop   = true
    a.volume = volume
    this._loops[name] = a
    if (this._enabled) a.play().catch(() => {})
  }

  async _startLoopWebAudio(name, volume) {
    if (!this._ctx) throw new Error('AudioContext is unavailable')
    const url = this._urls[name]
    if (!url) throw new Error(`Unknown audio loop: ${name}`)

    let buffer = this._loopBuffers[name]
    if (!buffer) {
      const res = await fetch(url)
      const arr = await res.arrayBuffer()
      buffer = await this._ctx.decodeAudioData(arr)
      this._loopBuffers[name] = buffer
    }

    const source = this._ctx.createBufferSource()
    source.buffer = buffer
    source.loop = true

    const gain = this._ctx.createGain()
    gain.gain.value = volume

    source.connect(gain)
    gain.connect(this._ctx.destination)
    source.start(0)

    this._loopSources[name] = source
    this._loopGains[name] = gain
  }

  /** Resume loops after enable() (in case they were registered before the gesture). */
  resumeLoops() {
    if (this._ctx && this._ctx.state === 'suspended') {
      this._ctx.resume().catch(() => {})
    }

    for (const a of Object.values(this._loops)) {
      if (a.paused) a.play().catch(() => {})
    }
  }

  /** Adjust volume of a running loop. */
  setLoopVolume(name, volume) {
    const g = this._loopGains[name]
    if (g) g.gain.value = Math.min(1, Math.max(0, volume))

    const a = this._loops[name]
    if (a) a.volume = Math.min(1, Math.max(0, volume))
  }

  /** Stop a looping sound. */
  stopLoop(name) {
    const src = this._loopSources[name]
    if (src) {
      try { src.stop() } catch {}
      src.disconnect()
      delete this._loopSources[name]
    }

    const g = this._loopGains[name]
    if (g) {
      g.disconnect()
      delete this._loopGains[name]
    }

    const a = this._loops[name]
    if (!a) return
    a.pause()
    a.currentTime = 0
    delete this._loops[name]
  }

  /** Stop everything. */
  stopAll() {
    for (const [name] of Object.entries(this._loops)) this.stopLoop(name)
  }
}
