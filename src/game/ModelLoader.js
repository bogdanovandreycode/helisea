import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'

const _loader = new GLTFLoader()

/** Load a GLB file; returns { scene, animations, … } */
export function loadGLB(url) {
  return new Promise((resolve, reject) =>
    _loader.load(url, resolve, undefined, reject)
  )
}

/**
 * Find the first Object3D whose name starts with `prefix` inside a GLTF scene.
 * @param {THREE.Object3D} root  - gltf.scene
 * @param {string} prefix
 * @returns {THREE.Object3D | null}
 */
export function findNode(root, prefix) {
  let found = null
  root.traverse(obj => {
    if (!found && obj.name.startsWith(prefix)) found = obj
  })
  return found
}

/**
 * Find all Object3Ds whose names start with `prefix`.
 */
export function findNodes(root, prefix) {
  const list = []
  root.traverse(obj => { if (obj.name.startsWith(prefix)) list.push(obj) })
  return list
}

/**
 * Hide all meshes whose names start with "COLLISION".
 * Also builds a BVH on their geometry (three-mesh-bvh must be patched in main.js).
 * Returns an array of the collision meshes (invisible but available for raycast tests).
 */
export function hideCollision(root) {
  const meshes = []
  root.traverse(obj => {
    if (obj.name.startsWith('COLLISION')) {
      obj.visible = false
      if (obj.isMesh) {
        // Build BVH if the prototype extension is present (patched in main.js)
        if (obj.geometry.computeBoundsTree) {
          obj.geometry.computeBoundsTree()
        }
        meshes.push(obj)
      }
    }
  })
  return meshes
}

/**
 * Compute an approximate bounding sphere for the visible meshes of a GLTF scene.
 */
export function computeBoundingSphere(root) {
  const box = new THREE.Box3()
  root.traverse(obj => {
    if (obj.isMesh && obj.visible) {
      obj.geometry.computeBoundingBox()
      const b = obj.geometry.boundingBox.clone()
      b.applyMatrix4(obj.matrixWorld)
      box.union(b)
    }
  })
  const sphere = new THREE.Sphere()
  box.getBoundingSphere(sphere)
  return sphere
}

/**
 * Enable shadow casting / receiving on all meshes in a GLTF scene.
 */
export function enableShadows(root) {
  root.traverse(obj => {
    if (obj.isMesh) {
      obj.castShadow = true
      obj.receiveShadow = true
    }
  })
}
