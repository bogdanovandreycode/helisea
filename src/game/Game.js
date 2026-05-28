import * as THREE from 'three'
import { World }            from './World.js'
import { Convoy }           from './Convoy.js'
import { Helicopter }       from './Helicopter.js'
import { WaveManager }      from './WaveManager.js'
import { ProjectileManager } from './Projectile.js'
import { AudioManager }     from './AudioManager.js'
import { HUD }              from './HUD.js'

/* Collision radii (sphere fallback when no BVH mesh available) */
const R_DRONE    = 5
const R_WARSHIP  = 32
const R_CARGO    = 26
const R_HELI     = 8

/* Shared raycaster for BVH collision */
const _ray       = new THREE.Raycaster()
const _rayOrigin = new THREE.Vector3()
const _rayDir    = new THREE.Vector3()

/**
 * Cast a swept ray for a projectile step and check against BVH collision meshes.
 * Returns true if intersection found.
 */
function _rayHitMeshes(fromPos, dir, stepDist, meshes) {
  if (!meshes || meshes.length === 0) return false
  _rayOrigin.copy(fromPos)
  _rayDir.copy(dir)
  _ray.set(_rayOrigin, _rayDir)
  _ray.far = stepDist + 1
  for (const mesh of meshes) {
    mesh.updateWorldMatrix(true, false)
    const hits = []
    mesh.raycast(_ray, hits)
    if (hits.length > 0) return true
  }
  return false
}


export class Game {
  constructor(container) {
    this._container = container
    this._state     = 'loading'   // loading | menu | playing | wave_clear | game_over

    /* Three.js core */
    this._renderer  = null
    this._scene     = null
    this._camera    = null

    /* Systems */
    this._world     = null
    this._convoy    = null
    this._heli      = null
    this._waves     = null
    this._projMgr   = null
    this._audio     = null
    this._hud       = null

    /* Game stats */
    this._score     = 0
    this._wave      = 0

    /* Input */
    this._keys      = new Set()
    this._mouseDelta = { dx: 0, dy: 0 }
    this._firing    = false
    this._pointerLocked = false

    /* Loop */
    this._lastTime  = 0
    this._rafId     = null

    /* Cinematic camera state (menu) */
    this._cinemaAngle = 0

    /* Contact collision cooldown (ram damage) */
    this._contactHitCd = 0
  }

  /* ════════════════════════════════════════════════
     Initialisation
  ════════════════════════════════════════════════ */

  async init() {
    this._setupRenderer()
    this._setupScene()
    this._setupInput()

    this._hud = new HUD(this._container)
    this._hud.onStart(() => this._startGame())
    this._hud.onRestart(() => this._restartGame())

    /* Audio (no user gesture yet) */
    this._audio = new AudioManager()
    this._audio.init()

    /* Load all scene assets */
    this._hud.showLoading()
    await this._loadWorld()
    this._hud.hideLoading()

    /* Show menu with cinema camera running */
    this._hud.showMenu()
    this._state = 'menu'
    this._loop(0)
  }

  async _loadWorld() {
    this._world   = new World(this._scene)
    this._projMgr = new ProjectileManager(this._scene)

    this._convoy  = new Convoy(this._scene, this._projMgr, this._audio)
    await this._convoy.init()

    this._heli = new Helicopter(this._scene, this._camera, this._projMgr, this._audio)
    await this._heli.init()

    // Position helicopter at spawn (off-screen before game starts)
    const spawnPos = this._convoy.getHelicopterSpawnPosition()
    this._heli.setPosition(spawnPos)
    this._heli.root.visible = false

    this._waves = new WaveManager(this._scene, this._projMgr, this._audio)
    await this._waves.preload()
    this._waves.setTargets(this._convoy.getTargetList())
  }

  /* ════════════════════════════════════════════════
     Game flow
  ════════════════════════════════════════════════ */

  _startGame() {
    this._audio.enable()
    this._audio.resumeLoops()
    this._audio.startLoop('helicopterNoise', 0.4)
    this._audio.play('menuSelect', 0.8)

    this._score = 0
    this._wave  = 1

    this._convoy.reset()
    const spawnPos = this._convoy.getHelicopterSpawnPosition()
    this._heli.reset(spawnPos)
    this._heli.root.visible = true

    this._waves.reset()
    this._waves.setTargets(this._convoy.getTargetList())
    this._waves.startWave(this._wave)

    this._projMgr.destroyAll()

    this._hud.hideMenu()
    this._hud.showGame()
    this._state = 'playing'

    this._container.requestPointerLock()
  }

  _restartGame() {
    this._audio.play('menuSelect', 0.8)
    this._startGame()
  }

  _onWaveComplete() {
    this._state = 'wave_clear'
    this._hud.showWaveClear(this._wave, this._score)

    setTimeout(() => {
      if (this._state !== 'wave_clear') return
      this._wave++
      this._waves.startWave(this._wave)
      this._state = 'playing'
    }, 3000)
  }

  _gameOver() {
    this._state = 'game_over'
    document.exitPointerLock()
    this._audio.stopAll()
    this._hud.showGameOver(this._score, this._wave)
  }

  /* ════════════════════════════════════════════════
     Main loop
  ════════════════════════════════════════════════ */

  _loop(ts) {
    this._rafId  = requestAnimationFrame(t => this._loop(t))
    const dt     = Math.min((ts - this._lastTime) / 1000, 0.05)
    this._lastTime = ts

    if (this._state === 'menu') {
      this._updateCinema(dt)
    } else if (this._state === 'playing' || this._state === 'wave_clear') {
      this._update(dt)
    }

    this._world?.update(dt)
    this._renderer.render(this._scene, this._camera)

    // Reset per-frame mouse delta
    this._mouseDelta.dx = 0
    this._mouseDelta.dy = 0
  }

  _updateCinema(dt) {
    /* Orbit camera around the convoy */
    this._cinemaAngle += dt * 0.12
    const r = 280, h = 90
    this._camera.position.set(
      Math.sin(this._cinemaAngle) * r,
      h,
      Math.cos(this._cinemaAngle) * r
    )
    this._camera.lookAt(0, 10, 0)
  }

  _update(dt) {
    this._contactHitCd = Math.max(0, this._contactHitCd - dt)

    /* Helicopter */
    this._heli.update(dt, this._keys, this._mouseDelta, this._firing)

    const listenerPos = this._heli.getPosition()

    /* Water level game over */
    if (this._heli.isAlive() && listenerPos.y < 0) {
      this._gameOver()
      return
    }

    /* Convoy + defenses */
    this._convoy.update(dt, this._waves.getDrones(), listenerPos)

    /* Waves / drones – pass helicopter position so drones can fire at it */
    this._waves.update(dt, listenerPos)

    /* Projectiles */
    this._projMgr.update(dt)

    /* Collision */
    this._checkCollisions(dt)

    /* Wave completion */
    if (this._state === 'playing' && this._waves.isWaveComplete()) {
      this._onWaveComplete()
    }

    /* Game over */
    if (this._convoy.isDefeated()) {
      this._gameOver()
      return
    }

    /* HUD data */
    this._hud.update({
      wave:        this._wave,
      score:       this._score,
      drones:      this._waves.getDrones().filter(d => d.isAlive()).length,
      ammo:        this._heli.ammo,
      warshipHP:   this._convoy.warshipHP,
      warshipMaxHP: this._convoy.warshipMaxHP,
      cargoHP:     this._convoy.cargoHP,
      cargoMaxHP:  this._convoy.cargoMaxHP,
      heliHP:      this._heli.hp,
      heliMaxHP:   100,
      pointerLocked: this._pointerLocked,
      heliAlive:   this._heli.isAlive(),
      respawnTimer: this._heli._respawnTimer,
    })

    /* Eagle-vision markers */
    const eagleTargets = []
    for (const d of this._waves.getDrones().filter(d => d.isAlive())) {
      eagleTargets.push({ pos: d.getPosition().clone().add(new THREE.Vector3(0, 5, 0)), label: 'DRN', type: 'drone' })
    }
    if (this._convoy.warshipRoot) {
      const wp = new THREE.Vector3()
      this._convoy.warshipRoot.getWorldPosition(wp)
      wp.y += 18
      eagleTargets.push({ pos: wp, label: 'FRD', type: 'friendly' })
    }
    for (let i = 0; i < this._convoy.cargoRoots.length; i++) {
      if (this._convoy.cargoHP[i] > 0 && this._convoy.cargoRoots[i]) {
        const cp = new THREE.Vector3()
        this._convoy.cargoRoots[i].getWorldPosition(cp)
        cp.y += 12
        eagleTargets.push({ pos: cp, label: 'FRD', type: 'friendly' })
      }
    }

    for (const m of this._projMgr.homingProjectiles()) {
      eagleTargets.push({ pos: m.getPosition().clone(), label: 'MSL', type: 'missile' })
    }

    this._hud.updateEagleVision(this._camera, eagleTargets)
  }

  /* ════════════════════════════════════════════════
     Collision detection (BVH ray-sweep + sphere fallback)
  ════════════════════════════════════════════════ */

  _checkCollisions(dt) {
    const drones         = this._waves.getDrones().filter(d => d.isAlive())
    const allyProj       = this._projMgr.allyProjectiles()
    const droneProj      = this._projMgr.droneProjectiles()
    const homingProj     = this._projMgr.homingProjectiles()

    const warshipPos     = this._convoy.getWarshipPosition()
    const cargoPositions = [0, 1, 2].map(i => this._convoy.getCargoShipPosition(i))
    const heliPos        = this._heli.getPosition()

    const warshipColl = this._convoy.warshipCollision
    const cargoColl   = this._convoy.cargoCollision
    const heliColl    = this._heli._collisionMeshes

    /* ── ally projectiles → drones (sphere) ── */
    for (const proj of allyProj) {
      const prevPos = proj.position.clone().addScaledVector(proj.direction, -proj.speed * 0.016)
      const stepDist = proj.speed * 0.016
      for (const drone of drones) {
        const dPos = drone.getPosition()
        const bonus = proj.type === 'cannon' ? 2.2 : 1.0
        if (proj.position.distanceTo(dPos) < R_DRONE + bonus) {
          const killed = drone.hp - proj.damage <= 0
          drone.hit(proj.damage)
          proj.destroy()
          if (killed) {
            this._score += proj.type === 'player' ? 100 : 25
            this._audio.play('cannonFire', 0.3)
          }
          break
        }
      }
    }

    /* ── homing (pvo) → drones (sphere) ── */
    for (const proj of homingProj) {
      for (const drone of drones) {
        if (proj.position.distanceTo(drone.getPosition()) < R_DRONE + 3.2) {
          drone.hit(proj.damage)
          proj.destroy()
          this._score += 50
          break
        }
      }
    }

    /* ── drone projectiles → ships (BVH) + helicopter (sphere) ── */
    for (const proj of droneProj) {
      const prevPos  = proj.position.clone().addScaledVector(proj.direction, -proj.speed * 0.016)
      const stepDist = proj.speed * 0.016

      // Warship – BVH first, sphere fallback
      const warshipHit = warshipColl.length > 0
        ? _rayHitMeshes(prevPos, proj.direction, stepDist, warshipColl)
        : proj.position.distanceTo(warshipPos) < R_WARSHIP
      if (warshipHit) {
        this._convoy.hitWarship(proj.damage)
        proj.destroy()
        continue
      }
      // Cargo ships
      let hit = false
      for (let i = 0; i < 3; i++) {
        if (!cargoPositions[i]) continue
        const cColl = cargoColl[i]
        const cargoHit = cColl && cColl.length > 0
          ? _rayHitMeshes(prevPos, proj.direction, stepDist, cColl)
          : proj.position.distanceTo(cargoPositions[i]) < R_CARGO
        if (cargoHit) {
          this._convoy.hitCargoShip(i, proj.damage)
          proj.destroy()
          hit = true
          break
        }
      }
      if (hit) continue
      // Helicopter – BVH first, sphere fallback
      if (this._heli.isAlive()) {
        const heliHit = heliColl.length > 0
          ? _rayHitMeshes(prevPos, proj.direction, stepDist, heliColl)
          : proj.position.distanceTo(heliPos) < R_HELI
        if (heliHit) {
          this._heli.hit(proj.damage)
          this._hud.flashHit()
          proj.destroy()
        }
      }
    }

    /* ── drone kamikaze (dive phase) → ships ── */
    for (const drone of drones) {
      if (drone._phase !== 'dive') continue   // only diving drones ram ships
      const dp = drone.getPosition()
      if (dp.distanceTo(warshipPos) < R_WARSHIP + 5) {
        this._convoy.hitWarship(45)
        drone.hit(9999)
        continue
      }
      for (let i = 0; i < 3; i++) {
        if (cargoPositions[i] && dp.distanceTo(cargoPositions[i]) < R_CARGO + 5) {
          this._convoy.hitCargoShip(i, 35)
          drone.hit(9999)
          break
        }
      }
    }

    /* ── helicopter contact collisions (mutual damage) ── */
    if (this._heli.isAlive() && this._contactHitCd <= 0) {
      let contact = false

      // Helicopter vs warship
      if (heliPos.distanceTo(warshipPos) < R_HELI + R_WARSHIP - 3) {
        this._heli.hit(34)
        this._convoy.hitWarship(20)
        contact = true
      }

      // Helicopter vs cargo
      if (!contact) {
        for (let i = 0; i < 3; i++) {
          if (!cargoPositions[i]) continue
          if (heliPos.distanceTo(cargoPositions[i]) < R_HELI + R_CARGO - 2) {
            this._heli.hit(30)
            this._convoy.hitCargoShip(i, 18)
            contact = true
            break
          }
        }
      }

      // Helicopter vs drone
      if (!contact) {
        for (const drone of drones) {
          if (heliPos.distanceTo(drone.getPosition()) < R_HELI + R_DRONE - 1) {
            this._heli.hit(26)
            drone.hit(55)
            contact = true
            break
          }
        }
      }

      if (contact) {
        this._hud.flashHit()
        this._contactHitCd = 0.33
      }
    }
  }

  /* ════════════════════════════════════════════════
     Setup helpers
  ════════════════════════════════════════════════ */

  _setupRenderer() {
    this._renderer = new THREE.WebGLRenderer({ antialias: true })
    this._renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this._renderer.setSize(window.innerWidth, window.innerHeight)
    this._renderer.shadowMap.enabled = true
    this._renderer.shadowMap.type    = THREE.PCFSoftShadowMap
    this._renderer.toneMapping       = THREE.ACESFilmicToneMapping
    this._renderer.toneMappingExposure = 1.1
    this._container.appendChild(this._renderer.domElement)

    window.addEventListener('resize', () => {
      if (!this._camera) return
      this._camera.aspect = window.innerWidth / window.innerHeight
      this._camera.updateProjectionMatrix()
      this._renderer.setSize(window.innerWidth, window.innerHeight)
    })
  }

  _setupScene() {
    this._scene  = new THREE.Scene()
    this._camera = new THREE.PerspectiveCamera(
      75, window.innerWidth / window.innerHeight, 0.1, 2000
    )
    // Initial position (cinema); overridden when in cockpit
    this._camera.position.set(280, 90, 0)
    this._camera.lookAt(0, 10, 0)
  }

  _setupInput() {
    window.addEventListener('keydown', e => {
      this._keys.add(e.code)
      // ESC exits pointer lock (handled by browser), also toggle lock back
      if (e.code === 'Escape' && this._state === 'playing') {
        document.exitPointerLock()
      }
    })
    window.addEventListener('keyup', e => this._keys.delete(e.code))

    window.addEventListener('mousemove', e => {
      if (!this._pointerLocked) return
      this._mouseDelta.dx += e.movementX
      this._mouseDelta.dy += e.movementY
    })

    window.addEventListener('mousedown', e => {
      if (e.button === 0) this._firing = true
      // Re-lock on click if in game but not locked
      if (e.button === 0 && this._state === 'playing' && !this._pointerLocked) {
        this._container.requestPointerLock()
      }
    })
    window.addEventListener('mouseup', e => {
      if (e.button === 0) this._firing = false
    })

    document.addEventListener('pointerlockchange', () => {
      this._pointerLocked = document.pointerLockElement === this._container
    })
  }

  /* Hot-reload cleanup */
  dispose() {
    if (this._rafId) cancelAnimationFrame(this._rafId)
    this._audio?.stopAll()
  }
}
