import test from 'node:test'
import assert from 'node:assert/strict'
import {
  duckSkinScore,
  duckTopProfile,
  getDuckSliceSpecs,
  heightBufferToNormalRGBA,
  plateSurfaceY,
} from './dishMath.js'

test('getDuckSliceSpecs produces anatomical center-peaked slice taper', () => {
  const specs = getDuckSliceSpecs(5)
  assert.equal(specs.length, 5)
  assert.ok(specs[2].lengthScale > specs[0].lengthScale)
  assert.ok(specs[2].lengthScale > specs[4].lengthScale)
  assert.ok(specs[2].heightScale > specs[0].heightScale)
  assert.notEqual(specs[0].uvShiftX, specs[1].uvShiftX)
})

test('duckTopProfile peaks in middle and tapers smoothly to edges', () => {
  const center = duckTopProfile(0, 0.25)
  const left = duckTopProfile(-1, 0.25)
  const right = duckTopProfile(1, 0.25)
  assert.ok(center > 0.2)
  assert.ok(left < 0.05)
  assert.ok(right < 0.05)
  assert.ok(duckTopProfile(-0.3, 0.25) !== duckTopProfile(0.3, 0.25))
})

test('duckSkinScore returns values in [0, 1] with distinct grooves and peaks', () => {
  let min = 1
  let max = 0
  for (let i = 0; i < 40; i++) {
    const v = duckSkinScore(i * 0.007, i * 0.003)
    assert.ok(v >= 0 && v <= 1)
    if (v < min) min = v
    if (v > max) max = v
  }
  assert.ok(max > 0.7, 'expected score grooves close to 1')
  assert.ok(min < 0.1, 'expected un-scored diamond centers close to 0')
})

test('heightBufferToNormalRGBA outputs flat (128,128,255) for uniform height and tilted normals on slopes', () => {
  const flat = new Float32Array(16).fill(0.5)
  const flatN = heightBufferToNormalRGBA(flat, 4, 4, 2.0)
  assert.equal(flatN.length, 16 * 4)
  // center pixel (1,1)
  const c = (1 * 4 + 1) * 4
  assert.equal(flatN[c], 128)
  assert.equal(flatN[c + 1], 128)
  assert.equal(flatN[c + 2], 255)
  assert.equal(flatN[c + 3], 255)

  // horizontal ramp rising left -> right should produce nx < 128
  const ramp = new Float32Array(16)
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      ramp[y * 4 + x] = x / 3
    }
  }
  const rampN = heightBufferToNormalRGBA(ramp, 4, 4, 2.0)
  assert.ok(rampN[c] < 110, `expected tilted nx < 110, got ${rampN[c]}`)
  assert.equal(rampN[c + 1], 128)
  assert.ok(rampN[c + 2] > 128)
})

test('plateSurfaceY rises monotonically from center well to rim', () => {
  const y0 = plateSurfaceY(0)
  const yMid = plateSurfaceY(0.72)
  const ySlope = plateSurfaceY(1.1)
  const yRim = plateSurfaceY(1.6)
  assert.ok(y0 < yMid)
  assert.ok(yMid < ySlope)
  assert.ok(ySlope < yRim)
})
