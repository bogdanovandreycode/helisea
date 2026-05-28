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
  }

  /** Pre-resolve all URL references (instant, no network). */
  init() {
    this._urls = { ...AUDIO }
  }

  /** Call after first user gesture. */
  enable() {
    if (this._enabled) return
    this._enabled = true
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

  /** Start a looping ambient sound (once). */
  startLoop(name, volume = 0.5) {
    if (this._loops[name]) return
    const url = this._urls[name]
    if (!url) return
    const a = new Audio(url)
    a.loop   = true
    a.volume = Math.min(1, Math.max(0, volume))
    this._loops[name] = a
    if (this._enabled) a.play().catch(() => {})
  }

  /** Resume loops after enable() (in case they were registered before the gesture). */
  resumeLoops() {
    for (const a of Object.values(this._loops)) {
      if (a.paused) a.play().catch(() => {})
    }
  }

  /** Adjust volume of a running loop. */
  setLoopVolume(name, volume) {
    const a = this._loops[name]
    if (a) a.volume = Math.min(1, Math.max(0, volume))
  }

  /** Stop a looping sound. */
  stopLoop(name) {
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
