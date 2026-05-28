import './style.css'
import * as THREE from 'three'
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh'
import { Game } from './game/Game.js'

// Patch Three.js prototypes so every mesh gets BVH-accelerated raycasting
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree
THREE.Mesh.prototype.raycast = acceleratedRaycast

const game = new Game(document.getElementById('app'))
game.init()

// keep a handle for hot-reload debugging
if (import.meta.hot) {
  import.meta.hot.dispose(() => game.dispose())
}

