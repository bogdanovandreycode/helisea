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

    // Update alive drones
    for (const d of this._drones) d.update(dt)

    // Purge dead drones (mesh already removed in _die())
    this._drones = this._drones.filter(d => d.isAlive())

    // Drone ambient noise – volume based on count × nearest-drone distance factor
    let minDist = Infinity
    let activeCnt = 0
    for (const d of this._drones) {
      if (d.isAlive()) {
        activeCnt++
        if (listenerPos) {
          const dist = d.getPosition().distanceTo(listenerPos)
          if (dist < minDist) minDist = dist
        }
      }
    }
    const distFactor = (listenerPos && minDist < Infinity) ? Math.max(0, 1 - minDist / 400) : 1
    const targetVol = Math.min(activeCnt * 0.04, 0.3) * distFactor
    this._droneVolume += (targetVol - this._droneVolume) * Math.min(dt * 2, 1)
    this.audio.setLoopVolume('droneNoise', this._droneVolume)
    if (activeCnt > 0 && this._droneVolume > 0.01) {
      this.audio.startLoop('droneNoise', this._droneVolume)
    }
  }

  _spawnDrone(pos) {
    const drone = new Drone(this.scene, pos, this.projMgr, this.audio)
    drone.buildMesh()

    // Assign a random target from convoy ships
    if (this._targets.length > 0) {
      const t = this._targets[Math.floor(Math.random() * this._targets.length)]
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
