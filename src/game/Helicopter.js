import * as THREE from 'three'
import { loadGLB, findNode, hideCollision, enableShadows } from './ModelLoader.js'
import { MODELS } from './assets.js'

const _PI2  = Math.PI * 2
const _HALF = Math.PI / 2

/* Flight tuning */
const MOVE_SPEED   = 30    // units/s horizontal
const CLIMB_SPEED  = 12    // units/s vertical
const MOUSE_SENS   = 0.0018 // radians per pixel
const TILT_AMOUNT  = 0.22  // body tilt on move (rad)
const ROTOR_SPEED  = 12    // rad/s
const MIN_ALTITUDE = 4
const MAX_ALTITUDE = 180

/* Weapon */
const FIRE_RATE    = 0.28  // seconds between shots
const AMMO_MAX     = 120

export class Helicopter {
  /**
   * @param {THREE.Scene}        scene
   * @param {THREE.PerspectiveCamera} camera
   * @param {ProjectileManager}  projMgr
   * @param {AudioManager}       audio
   */
  constructor(scene, camera, projMgr, audio) {
    this.scene   = scene
    this.camera  = camera
    this.projMgr = projMgr
    this.audio   = audio

    /* orientation */
    this._yaw   = 0    // world-space heading (radians, around Y)
    this._pitch = 0    // extra camera look-up/down (radians)

    /* state */
    this.hp        = 100
    this.ammo      = AMMO_MAX
    this._fireCd   = 0
    this._fireAlt  = false   // alternate left/right
    this._alive    = true
    this._respawnTimer = 0

    /* 3-D hierarchy */
    this.root        = new THREE.Object3D()  // yaw pivot
    this._bodyScene  = null
    this._vint       = null
    this._cameraNode = null
    this._weaponL    = null
    this._weaponR    = null

    /* smoothed tilt */
    this._tiltX = 0  // pitch tilt of body
    this._tiltZ = 0  // roll tilt of body

    scene.add(this.root)
  }

  async init() {
    const [bodyGltf, vintGltf] = await Promise.all([
      loadGLB(MODELS.heliBody),
      loadGLB(MODELS.heliVint),
    ])

    /* body */
    this._bodyScene = bodyGltf.scene
    hideCollision(this._bodyScene)
    enableShadows(this._bodyScene)
    this.root.add(this._bodyScene)

    /* rotor – attach to VINT node */
    const vintNode = findNode(this._bodyScene, 'VINT')
    if (vintNode) {
      const vint = vintGltf.scene
      hideCollision(vint)
      enableShadows(vint)
      vintNode.add(vint)
      this._vint = vint
    }

    /* camera – find CAMERA node; will be attached in reset() */
    const camNode = findNode(this._bodyScene, 'CAMERA')
    if (camNode) {
      this._cameraNode = camNode
    } else {
      // Fallback: use root as camera parent
      this._cameraNode = this.root
    }

    /* weapon mounts */
    this._weaponL = findNode(this._bodyScene, 'WEAPON_LEFT')
    this._weaponR = findNode(this._bodyScene, 'WEAPON_RIGHT')
  }

  setPosition(pos) {
    this.root.position.copy(pos)
  }

  getPosition() {
    const p = new THREE.Vector3()
    this.root.getWorldPosition(p)
    return p
  }

  isAlive() { return this._alive }

  /* ─────────────── input & update ─────────────── */

  /**
   * @param {number}  dt  seconds
   * @param {Set}     keys  set of pressed KeyboardEvent.codes
   * @param {object}  mouseDelta  {dx, dy}  accumulated mouse movement
   * @param {boolean} firing  left mouse button held
   */
  update(dt, keys, mouseDelta, firing) {
    if (!this._alive) {
      this._respawnTimer -= dt
      if (this._respawnTimer <= 0) this._respawn()
      return
    }

    /* ── yaw from mouse X ── */
    this._yaw -= mouseDelta.dx * MOUSE_SENS
    this.root.rotation.y = this._yaw

    /* ── camera pitch from mouse Y ── */
    this._pitch -= mouseDelta.dy * MOUSE_SENS
    this._pitch = Math.max(-_HALF * 0.9, Math.min(_HALF * 0.6, this._pitch))
    if (this._cameraNode) this._cameraNode.rotation.x = this._pitch

    /* ── movement ── */
    const fwd  = new THREE.Vector3(-Math.sin(this._yaw), 0, -Math.cos(this._yaw))
    const right = new THREE.Vector3( Math.cos(this._yaw), 0, -Math.sin(this._yaw))

    let dx = 0, dz = 0, dy = 0
    if (keys.has('KeyW')) { dx += fwd.x;   dz += fwd.z;   }
    if (keys.has('KeyS')) { dx -= fwd.x;   dz -= fwd.z;   }
    if (keys.has('KeyD')) { dx += right.x; dz += right.z; }
    if (keys.has('KeyA')) { dx -= right.x; dz -= right.z; }
    if (keys.has('Space'))      dy =  1
    if (keys.has('ShiftLeft') || keys.has('ShiftRight')) dy = -1

    this.root.position.x += dx * MOVE_SPEED * dt
    this.root.position.z += dz * MOVE_SPEED * dt
    this.root.position.y  = Math.max(
      MIN_ALTITUDE,
      Math.min(MAX_ALTITUDE, this.root.position.y + dy * CLIMB_SPEED * dt)
    )

    /* ── body tilt (visual) ── */
    const targetTiltX = -dz * TILT_AMOUNT  // pitch forward/back
    const targetTiltZ = -dx * TILT_AMOUNT  // roll left/right
    const lerpRate = 5 * dt
    this._tiltX += (targetTiltX - this._tiltX) * lerpRate
    this._tiltZ += (targetTiltZ - this._tiltZ) * lerpRate
    if (this._bodyScene) {
      this._bodyScene.rotation.x = this._tiltX
      this._bodyScene.rotation.z = this._tiltZ
    }

    /* ── rotor spin ── */
    if (this._vint) this._vint.rotation.y += ROTOR_SPEED * dt

    /* ── fire ── */
    this._fireCd -= dt
    if (firing && this._fireCd <= 0 && this.ammo > 0) {
      this._fire()
    }
  }

  _fire() {
    this._fireCd = FIRE_RATE
    this.ammo--

    /* Get world-space position & direction of camera */
    const dir = new THREE.Vector3()
    this.camera.getWorldDirection(dir)

    /* Alternate left / right weapon */
    const wNode = this._fireAlt ? this._weaponR : this._weaponL
    this._fireAlt = !this._fireAlt

    const pos = new THREE.Vector3()
    if (wNode) {
      wNode.getWorldPosition(pos)
    } else {
      this.camera.getWorldPosition(pos)
    }

    this.projMgr.spawn(pos, dir, {
      type:    'player',
      speed:   160,
      damage:  40,
      maxDist: 600,
    })

    this.audio.play('cannonFire', 0.5)
  }

  hit(damage) {
    if (!this._alive) return
    this.hp = Math.max(0, this.hp - damage)
    this.audio.play('playerHit', 0.8)
    if (this.hp <= 0) this._crash()
  }

  _crash() {
    this._alive      = false
    this._respawnTimer = 5
    // Detach camera so it stays visible during respawn countdown
    if (this._cameraNode) {
      const worldPos = new THREE.Vector3()
      const worldQuat = new THREE.Quaternion()
      this.camera.getWorldPosition(worldPos)
      this.camera.getWorldQuaternion(worldQuat)
      this._cameraNode.remove(this.camera)
      this.scene.add(this.camera)
      this.camera.position.copy(worldPos)
      this.camera.quaternion.copy(worldQuat)
    }
    this.root.visible = false
  }

  _respawn() {
    this._alive = true
    this.hp     = 100
    this.ammo   = AMMO_MAX
    this.root.visible = true

    // Re-attach camera
    if (this._cameraNode) {
      this.scene.remove(this.camera)
      this._cameraNode.add(this.camera)
      this.camera.position.set(0, 0, 0)
      this.camera.rotation.set(0, 0, 0)
    }
  }

  reset(spawnPos) {
    this.hp     = 100
    this.ammo   = AMMO_MAX
    this._alive = true
    this._yaw   = 0
    this._pitch = 0
    this.root.visible = true
    this.root.rotation.set(0, 0, 0)
    if (spawnPos) this.root.position.copy(spawnPos)

    // Always (re-)attach camera to its node with zero local offset
    if (this._cameraNode) {
      if (this.camera.parent) this.camera.parent.remove(this.camera)
      this._cameraNode.add(this.camera)
      this.camera.position.set(0, 0, 0)
      this.camera.rotation.set(0, 0, 0)
    }
  }
}
