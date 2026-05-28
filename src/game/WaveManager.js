import * as THREE from 'three'
import { Drone, preloadDroneAssets } from './Drone.js'

/* Spawn directions relative to convoy centre */
const SPAWN_ZONES = [
  // Front
  () => new THREE.Vector3((Math.random() - 0.5) * 200, 30 + Math.random() * 20, -450),
  // Left flank
  () => new THREE.Vector3(-420, 30 + Math.random() * 20, (Math.random() - 0.5) * 300),
  // Right flank
  () => new THREE.Vector3( 420, 30 + Math.random() * 20, (Math.random() - 0.5) * 300),
  // Front-left
  () => new THREE.Vector3(-300 - Math.random() * 100, 30 + Math.random() * 20, -350),
  // Front-right
  () => new THREE.Vector3( 300 + Math.random() * 100, 30 + Math.random() * 20, -350),
]

export class WaveManager {
  /**
   * @param {THREE.Scene}       scene
   * @param {ProjectileManager} projMgr
   * @param {AudioManager}      audio
   */
  constructor(scene, projMgr, audio) {
    this.scene   = scene
    this.projMgr = projMgr
    this.audio   = audio

    this._drones       = []   // active Drone instances
    this._waveNumber   = 0
    this._spawnQueue   = []   // positions waiting to spawn
    this._spawnTimer   = 0
    this._spawnDelay   = 1.5  // seconds between spawns
    this._targets      = []   // [{position, radius}] – convoy ship targets
    this._waveActive   = false
    this._droneVolume  = 0
  }

  async preload() {
    await preloadDroneAssets()
  }

  /** Provide convoy ship positions for drones to target. */
  setTargets(targets) {
    this._targets = targets
  }

  /** Start a new wave. waveNum starts at 1. */
  startWave(waveNum) {
    this._waveNumber = waveNum
    this._drones = []
    this._waveActive = true

    // Build spawn queue
    const count = this._droneCountForWave(waveNum)
    this._spawnQueue = []
    for (let i = 0; i < count; i++) {
      const zone = SPAWN_ZONES[Math.floor(Math.random() * SPAWN_ZONES.length)]
      this._spawnQueue.push(zone())
    }
    this._spawnTimer = 0

    // Stagger zone variety increases with wave
    if (waveNum >= 3) {
      // Add rear-attack drones
      const extra = Math.floor(waveNum / 3)
      for (let i = 0; i < extra; i++) {
        this._spawnQueue.push(new THREE.Vector3(
          (Math.random() - 0.5) * 200, 30, 350
        ))
      }
    }
  }

  _droneCountForWave(wave) {
    return Math.min(5 + (wave - 1) * 3, 25)
  }

  getDrones()   { return this._drones }
  getWaveNum()  { return this._waveNumber }

  /** True when all drones for this wave are dead and spawn queue is empty. */
  isWaveComplete() {
    return this._waveActive &&
      this._spawnQueue.length === 0 &&
      this._drones.every(d => !d.isAlive())
  }

  update(dt, listenerPos) {
    if (!this._waveActive) return

    // Spawn queued drones gradually
    if (this._spawnQueue.length > 0) {
      this._spawnTimer -= dt
      if (this._spawnTimer <= 0) {
        this._spawnTimer = this._spawnDelay
        const pos = this._spawnQueue.shift()
        this._spawnDrone(pos)
      }
    }

    // Update alive drones – pass helicopter position for targeting
    for (const d of this._drones) d.update(dt, listenerPos)

    // Purge dead drones (mesh already removed in _die())
    this._drones = this._drones.filter(d => d.isAlive())

    // Drone ambient noise – only two nearest drones contribute to volume.
    const dists = []
    let activeCnt = 0
    for (const d of this._drones) {
      if (d.isAlive()) {
        activeCnt++
        if (listenerPos) {
          const dist = d.getPosition().distanceTo(listenerPos)
          dists.push(dist)
        }
      }
    }

    let targetVol = 0
    if (listenerPos && dists.length > 0) {
      dists.sort((a, b) => a - b)
      const top2 = dists.slice(0, 2)
      let sum = 0
      for (const dist of top2) sum += Math.max(0, 1 - dist / 360)
      targetVol = Math.min(sum * 0.18, 0.32)
    } else {
      targetVol = Math.min(activeCnt, 2) * 0.08
    }

    this._droneVolume += (targetVol - this._droneVolume) * Math.min(dt * 2, 1)
    this.audio.setLoopVolume('droneNoise', this._droneVolume)

    if (activeCnt > 0 && this._droneVolume > 0.01) {
      this.audio.startLoop('droneNoise', this._droneVolume)
    } else if (activeCnt === 0) {
      this.audio.stopLoop('droneNoise')
    }
  }

  _spawnDrone(pos) {
    const drone = new Drone(this.scene, pos, this.projMgr, this.audio)
    drone.buildMesh()

    // Priority targeting: cargo first, then warship.
    if (this._targets.length > 0) {
      const cargoTargets = this._targets.filter(t => t.type === 'cargo' && t.alive)
      const warshipTargets = this._targets.filter(t => t.type === 'warship' && t.alive)

      let pool = cargoTargets
      if (pool.length === 0) pool = warshipTargets
      if (pool.length === 0) pool = this._targets

      const t = pool[Math.floor(Math.random() * pool.length)]
      drone.setTarget(t.position, t.radius)
    }

    this._drones.push(drone)
  }

  reset() {
    for (const d of this._drones) {
      if (d.isAlive()) this.scene.remove(d.root)
    }
    this._drones = []
    this._spawnQueue = []
    this._waveActive = false
    this._waveNumber = 0
  }
}
