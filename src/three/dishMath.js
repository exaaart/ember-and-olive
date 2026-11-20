import { clamp01, smooth } from './noise.js'

/**
 * Pure deterministic math utilities for procedural dish geometry and PBR map synthesis.
 */

/**
 * Anatomical duck breast slice sizing (5 slices fanned across the plate).
 * Center slices are broader and taller; outer ends taper naturally like a real magret de canard.
 */
export function getDuckSliceSpecs(count = 5) {
  const specs = []
  const mid = (count - 1) / 2
  for (let i = 0; i < count; i++) {
    const t = mid > 0 ? (i - mid) / mid : 0 // -1 .. +1
    const arch = Math.sqrt(Math.max(0.15, 1 - 0.36 * t * t))
    specs.push({
      index: i,
      norm: t,
      lengthScale: 0.78 + 0.28 * arch + (i === 1 ? 0.03 : 0),
      heightScale: 0.8 + 0.25 * arch,
      thicknessScale: 0.92 + 0.14 * arch,
      slump: 0.016 + 0.008 * (1 - Math.abs(t)),
      yawOffset: t * 0.16,
      rollOffset: t * 0.035,
      uvShiftX: (i * 0.173) % 0.45,
      uvShiftY: (i * 0.097) % 0.18,
      tint: 0.95 + 0.07 * Math.sin(i * 1.9 + 0.4),
    })
  }
  return specs
}

/**
 * Top silhouette profile y(u) of a duck breast slice for normalized x coordinate u in [-1, 1].
 * Slightly asymmetric (fuller toward the sternum side, gently tapered on the wing side).
 */
export function duckTopProfile(u, height = 0.245) {
  const cu = Math.max(-1, Math.min(1, u))
  const dome = Math.pow(Math.max(0, 1 - cu * cu), 0.56)
  const asym = 1 - 0.11 * cu + 0.04 * Math.sin(cu * 2.4)
  return 0.024 + (height - 0.024) * dome * asym
}

/**
 * Computes diamond cross-hatch score depth [0..1] for crispy roasted duck skin.
 */
export function duckSkinScore(x, z, pitch = 0.082) {
  const a = (x + z * 1.15) / pitch
  const b = (x - z * 1.15) / pitch
  const da = Math.abs(((a % 1) + 1.5) % 1 - 0.5)
  const db = Math.abs(((b % 1) + 1.5) % 1 - 0.5)
  const grooveA = 1 - smooth(0.03, 0.14, da)
  const grooveB = 1 - smooth(0.03, 0.14, db)
  return clamp01(Math.max(grooveA, grooveB))
}

/**
 * Converts a grayscale float height buffer [0..1] of size W x H into a tangent-space
 * OpenGL RGBA normal map (Uint8Array) using a 3x3 Sobel operator.
 */
export function heightBufferToNormalRGBA(heights, width, height, strength = 2.0, wrap = false) {
  const out = new Uint8Array(width * height * 4)
  const sample = (x, y) => {
    let sx = x
    let sy = y
    if (wrap) {
      sx = ((x % width) + width) % width
      sy = ((y % height) + height) % height
    } else {
      sx = x < 0 ? 0 : x >= width ? width - 1 : x
      sy = y < 0 ? 0 : y >= height ? height - 1 : y
    }
    return heights[sy * width + sx]
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const tl = sample(x - 1, y - 1)
      const t = sample(x, y - 1)
      const tr = sample(x + 1, y - 1)
      const l = sample(x - 1, y)
      const r = sample(x + 1, y)
      const bl = sample(x - 1, y + 1)
      const b = sample(x, y + 1)
      const br = sample(x + 1, y + 1)

      const dx = (tr + 2 * r + br - (tl + 2 * l + bl)) * strength
      const dy = (bl + 2 * b + br - (tl + 2 * t + tr)) * strength

      // Tangent-space normal pointing +Z (OpenGL convention: +Y up -> flip dy)
      let nx = -dx
      let ny = dy
      let nz = 1.0
      const invLen = 1 / Math.hypot(nx, ny, nz)
      nx *= invLen
      ny *= invLen
      nz *= invLen

      const idx = (y * width + x) * 4
      out[idx] = Math.round((nx * 0.5 + 0.5) * 255)
      out[idx + 1] = Math.round((ny * 0.5 + 0.5) * 255)
      out[idx + 2] = Math.round((nz * 0.5 + 0.5) * 255)
      out[idx + 3] = 255
    }
  }
  return out
}

/**
 * Evaluates a culinary stoneware plate height at radius r from center.
 * Gently concave well rising smoothly into a handmade lip.
 */
export function plateSurfaceY(r, wellBase = 0.062) {
  if (r <= 0.72) {
    // subtle concave dip (2.5mm) so sauces nestle realistically
    const k = r / 0.72
    return wellBase + 0.005 * k * k
  }
  if (r <= 1.24) {
    const k = smooth(0.72, 1.24, r)
    return wellBase + 0.005 + k * 0.056
  }
  const k = smooth(1.24, 1.62, r)
  return wellBase + 0.061 + k * 0.052
}
