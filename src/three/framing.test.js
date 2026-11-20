import test from 'node:test'
import assert from 'node:assert/strict'
import { computeCameraRig, computeModelNormalization } from './framing.js'

test('computeModelNormalization centers XZ, grounds min.y to 0, and scales to targetSpan', () => {
  const bounds = {
    min: { x: -0.1, y: 0.05, z: -0.15 },
    max: { x: 0.3, y: 0.25, z: 0.25 },
  }
  const res = computeModelNormalization(bounds, { targetSpan: 3.2, maxHeight: 2.4 })
  // span = 0.4 -> scale = 8
  assert.ok(Math.abs(res.scale - 8) < 1e-6)
  // grounded min.y: 0.05 * 8 + offsetY === 0
  assert.ok(Math.abs(bounds.min.y * res.scale + res.offsetY) < 1e-6)
  // centered X: center = 0.1 -> 0.1 * 8 + offsetX === 0
  assert.ok(Math.abs(0.1 * res.scale + res.offsetX) < 1e-6)
  assert.ok(Math.abs(res.normalizedHeight - 1.6) < 1e-6)
  assert.ok(Math.abs(res.radius - 1.6) < 1e-6)
})

test('computeModelNormalization clamps scale when model height exceeds maxHeight', () => {
  const tallBounds = {
    min: { x: -0.5, y: 0, z: -0.5 },
    max: { x: 0.5, y: 2.0, z: 0.5 },
  }
  const res = computeModelNormalization(tallBounds, { targetSpan: 3.0, maxHeight: 2.0 })
  // Width scale would be 3.0 (height 6.0), clamped by maxHeight = 2.0 -> scale = 1.0
  assert.ok(Math.abs(res.scale - 1.0) < 1e-6)
  assert.ok(Math.abs(res.normalizedHeight - 2.0) < 1e-6)
})

test('computeCameraRig frames tall covered dish cleanly on desktop and mobile', () => {
  const desktop = computeCameraRig({
    aspect: 1.15,
    fovDeg: 24,
    modelRadius: 1.55,
    modelHeight: 2.1,
    isSmall: false,
  })
  const mobile = computeCameraRig({
    aspect: 0.85,
    fovDeg: 24,
    modelRadius: 1.55,
    modelHeight: 2.1,
    isSmall: true,
  })

  assert.ok(desktop.distance > 6 && desktop.distance < 16)
  assert.ok(desktop.targetY > 0.5 && desktop.targetY < 1.2)
  assert.ok(desktop.cameraY > desktop.targetY)
  assert.ok(desktop.cameraZ > 0)
  // Narrower mobile aspect pushes camera back so plate rims never clip horizontally
  assert.ok(mobile.distance > desktop.distance)
})
