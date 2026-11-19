import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { createNoise, mulberry32, smooth, clamp01 } from './noise.js'

/**
 * Процедурное блюдо «утиная грудка с углей»:
 * керамическая тарелка ручной работы, мазок тыквенного пюре, веер ломтиков утки,
 * печёная свёкла, вишнёвый соус, оливковое масло, фундук, соль и микрозелень.
 *
 * Масштаб: 1 единица ≈ 8 см (тарелка ~27 см).
 */

const WELL = 0.064 // высота дна тарелки
const E = 1.72 // половина размера плоской UV-проекции тарелки

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const hex = (h) => [(h >> 16) & 255, (h >> 8) & 255, h & 255]
function lerpC(a, b, t, out) {
  out[0] = a[0] + (b[0] - a[0]) * t
  out[1] = a[1] + (b[1] - a[1]) * t
  out[2] = a[2] + (b[2] - a[2]) * t
  return out
}
function makeCanvas(w, h) {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return c
}
function toTexture(cv, { srgb = false, aniso = 1, wrap = THREE.ClampToEdgeWrapping } = {}) {
  const t = new THREE.CanvasTexture(cv)
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace
  t.anisotropy = aniso
  t.wrapS = t.wrapT = wrap
  t.needsUpdate = true
  return t
}
// плоская проекция тарелки: мир (x, z) -> пиксели канваса
const toPx = (x, z, S) => [(x / (2 * E) + 0.5) * S, (0.5 - z / (2 * E)) * S]

const _ray = new THREE.Raycaster()
const _down = new THREE.Vector3(0, -1, 0)
const _origin = new THREE.Vector3()
function dropOnto(surfaces, x, z) {
  _origin.set(x, 3, z)
  _ray.set(_origin, _down)
  const hit = _ray.intersectObjects(surfaces, false)[0]
  // дно тарелки плоское — если еды под точкой нет, кладём на него
  if (!hit) return { point: new THREE.Vector3(x, WELL, z), normal: new THREE.Vector3(0, 1, 0), object: null }
  const n = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : new THREE.Vector3(0, 1, 0)
  return { point: hit.point.clone(), normal: n, object: hit.object }
}

// ---------------------------------------------------------------------------
// entry
// ---------------------------------------------------------------------------
export function buildProceduralDish({ quality = 'high', anisotropy = 4 } = {}) {
  const hi = quality === 'high'
  const N = createNoise(17)
  const rand = mulberry32(29)
  const ctx = { N, rand, hi, aniso: anisotropy }

  const dish = new THREE.Group()
  dish.name = 'procedural-dish'

  const micro = microTexture(N, hi ? 256 : 128, anisotropy)

  const plate = buildPlate(ctx)
  dish.add(plate.group)

  const food = []
  const addFood = (m, { cast = true } = {}) => {
    m.castShadow = cast
    m.receiveShadow = true
    dish.add(m)
    food.push(m)
    return m
  }

  const sauce = buildSauce(ctx)
  sauce.forEach((m) => addFood(m, { cast: false }))

  const puree = buildPuree(ctx, micro)
  addFood(puree.mesh)

  const duck = buildDuck(ctx, micro)
  dish.add(duck.group)
  duck.meshes.forEach((m) => food.push(m))

  buildBeets(ctx, micro).forEach((m) => addFood(m))
  buildOil(ctx).forEach((m) => addFood(m, { cast: false }))

  dish.updateMatrixWorld(true)

  // гарнир «падает» на поверхности сверху — ничего не висит в воздухе
  const surfaces = [puree.mesh, ...duck.meshes]
  const garnish = buildGarnish(ctx, micro, surfaces, puree, duck)
  garnish.forEach((o) => {
    dish.add(o)
    o.traverse((c) => {
      if (c.isMesh) {
        c.castShadow = true
        c.receiveShadow = true
        food.push(c)
      }
    })
  })
  dish.updateMatrixWorld(true)

  // контактные тени, запечённые в глазурь тарелки
  plate.applyTextures(food)

  return dish
}

// ---------------------------------------------------------------------------
// micro bump (общая мелкая фактура)
// ---------------------------------------------------------------------------
function microTexture(N, S, aniso) {
  const cv = makeCanvas(S, S)
  const g = cv.getContext('2d')
  const img = g.createImageData(S, S)
  const d = img.data
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const v = 0.5 + 0.5 * N.fbm2(x * 0.045 + 50, y * 0.045, 4)
      const i = (y * S + x) * 4
      d[i] = d[i + 1] = d[i + 2] = v * 255
      d[i + 3] = 255
    }
  }
  g.putImageData(img, 0, 0)
  return toTexture(cv, { aniso, wrap: THREE.MirroredRepeatWrapping })
}

// ---------------------------------------------------------------------------
// plate
// ---------------------------------------------------------------------------
// Профили (r, y). Порядок точек задаёт направление нормалей LatheGeometry.
const TOP_PROFILE = [
  [1.6, 0.127], [1.632, 0.137], [1.644, 0.15], [1.636, 0.162], [1.612, 0.168], [1.56, 0.166],
  [1.46, 0.155], [1.3, 0.13], [1.12, 0.096], [0.98, 0.074], [0.86, 0.066], [0.6, 0.064], [0.3, 0.064], [0, 0.064],
]
const UNDER_PROFILE = [
  [0, 0.026], [0.3, 0.024], [0.54, 0.016], [0.585, 0.003], [0.63, 0], [0.672, 0.006], [0.69, 0.034],
  [0.82, 0.046], [1.12, 0.074], [1.42, 0.106], [1.6, 0.127],
]

function latheGeo(profile, segments, N) {
  const curve = new THREE.CatmullRomCurve3(
    profile.map(([r, y]) => new THREE.Vector3(r, y, 0)),
    false,
    'centripetal',
  )
  const pts = curve.getSpacedPoints(profile.length * 7).map((p) => new THREE.Vector2(Math.max(0, p.x), p.y))
  let g = new THREE.LatheGeometry(pts, segments)
  g.deleteAttribute('normal')
  g.deleteAttribute('uv')
  g = mergeVertices(g, 1e-5)

  // ручная работа: лёгкая волна борта и неровность радиуса
  const pos = g.attributes.position
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    const y = pos.getY(i)
    const z = pos.getZ(i)
    const r = Math.hypot(x, z)
    if (r < 1e-5) continue
    const ca = x / r
    const sa = z / r
    const k = smooth(0.95, 1.6, r)
    const wob = N.noise2(ca * 1.3 + 3, sa * 1.3) * 0.007 + N.noise2(ca * 4 + 1, sa * 4 + 7) * 0.0022
    const rs = 1 + N.noise2(ca * 1.1 + 11, sa * 1.1 - 2) * 0.004 * k
    pos.setXYZ(i, x * rs, y + wob * k, z * rs)
  }
  g.computeVertexNormals()

  const uv = new Float32Array(pos.count * 2)
  for (let i = 0; i < pos.count; i++) {
    uv[i * 2] = pos.getX(i) / (2 * E) + 0.5
    uv[i * 2 + 1] = pos.getZ(i) / (2 * E) + 0.5
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  return g
}

function buildPlate({ N, hi, aniso }) {
  const segs = hi ? 180 : 120
  const glazeMat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    roughness: 1,
    clearcoat: 0.6,
    clearcoatRoughness: 0.08,
    specularIntensity: 0.7,
  })
  const clayMat = new THREE.MeshStandardMaterial({ color: 0x9a684a, roughness: 0.9 })

  const top = new THREE.Mesh(latheGeo(TOP_PROFILE, segs, N), glazeMat)
  const under = new THREE.Mesh(latheGeo(UNDER_PROFILE, segs, N), clayMat)
  ;[top, under].forEach((m) => {
    m.castShadow = true
    m.receiveShadow = true
  })
  const group = new THREE.Group()
  group.add(top, under)

  function applyTextures(food) {
    const S = hi ? 768 : 512
    const t = plateTextures(N, S, food, aniso)
    glazeMat.map = t.map
    glazeMat.roughnessMap = t.rough
    glazeMat.bumpMap = t.bump
    glazeMat.bumpScale = 0.35
    glazeMat.needsUpdate = true
    clayMat.bumpMap = t.bump
    clayMat.bumpScale = 1.2
    clayMat.needsUpdate = true
  }

  return { group, top, applyTextures }
}

function plateTextures(N, S, food, aniso) {
  const cvC = makeCanvas(S, S)
  const cvR = makeCanvas(S, S)
  const cvB = makeCanvas(S, S)
  const gC = cvC.getContext('2d')
  const gR = cvR.getContext('2d')
  const gB = cvB.getContext('2d')
  const iC = gC.createImageData(S, S)
  const iR = gR.createImageData(S, S)
  const iB = gB.createImageData(S, S)
  const dC = iC.data
  const dR = iR.data
  const dB = iB.data

  const cream = hex(0xeee9df)
  const cream2 = hex(0xe2d9c8)
  const glazeA = hex(0x221812)
  const glazeB = hex(0x3a2a20)
  const olive = hex(0x3c3a2a)
  const rust = hex(0x7e4d30)
  const lipC = hex(0x6a4630)
  const tmp = [0, 0, 0]
  const tmp2 = [0, 0, 0]

  // граница тёмной глазури зависит только от угла — считаем один раз
  const BINS = 2048
  const rbLut = new Float32Array(BINS)
  for (let b = 0; b < BINS; b++) {
    const a = (b / BINS) * Math.PI * 2
    rbLut[b] = 1.21 + 0.02 * N.fbm2(Math.cos(a) * 1.8 + 5, Math.sin(a) * 1.8 - 3, 3)
  }
  const RMAX = 1.68

  for (let py = 0; py < S; py++) {
    const z = (0.5 - (py + 0.5) / S) * 2 * E
    for (let px = 0; px < S; px++) {
      const x = ((px + 0.5) / S - 0.5) * 2 * E
      const r = Math.hypot(x, z)
      const i = (py * S + px) * 4
      if (r > RMAX) {
        // за пределами тарелки — цвет края, без шума
        dC[i] = lipC[0]
        dC[i + 1] = lipC[1]
        dC[i + 2] = lipC[2]
        dC[i + 3] = 255
        dR[i] = dR[i + 1] = dR[i + 2] = 80
        dR[i + 3] = 255
        dB[i] = dB[i + 1] = dB[i + 2] = 128
        dB[i + 3] = 255
        continue
      }
      const inv = r > 1e-4 ? 1 / r : 0
      const ca = x * inv
      const sa = z * inv

      const lf = N.fbm2(x * 1.4 + 10, z * 1.4, 2) * 0.5 + 0.5
      lerpC(cream, cream2, lf * 0.75, tmp)
      let rough = 0.22 + 0.06 * lf
      let bump = 0.5 + 0.035 * N.noise2(x * 70, z * 70)

      let ang = Math.atan2(z, x)
      if (ang < 0) ang += Math.PI * 2
      const rb = rbLut[Math.min(BINS - 1, Math.floor((ang / (Math.PI * 2)) * BINS))] + 0.006 * N.noise2(x * 16, z * 16)
      if (r > rb - 0.03) {
        const k = smooth(rb - 0.01, rb + 0.05, r)
        // мягкие разводы глазури: низкая частота по кругу, без «солнечных лучей»
        const streak = N.fbm3(ca * 3.5, sa * 3.5, r * 2.2, 3) * 0.5 + 0.5
        const streak2 = N.noise3(ca * 9 + 3, sa * 9, r * 3) * 0.5 + 0.5
        lerpC(glazeA, glazeB, smooth(0.25, 0.8, streak), tmp2)
        lerpC(tmp2, olive, smooth(0.6, 0.95, streak2) * 0.5, tmp2)
        const edge = smooth(rb - 0.015, rb + 0.01, r) * (1 - smooth(rb + 0.01, rb + 0.05, r))
        lerpC(tmp2, rust, edge * 0.6, tmp2)
        const lip = smooth(1.575, 1.645, r)
        lerpC(tmp2, lipC, lip * 0.75, tmp2)
        lerpC(tmp, tmp2, k, tmp)
        rough = rough * (1 - k) + (0.1 + 0.06 * streak + edge * 0.12 + lip * 0.18) * k
        bump += ((streak2 - 0.5) * 0.14 + edge * 0.08) * k
      }

      dC[i] = tmp[0]
      dC[i + 1] = tmp[1]
      dC[i + 2] = tmp[2]
      dC[i + 3] = 255
      const rv = clamp01(rough) * 255
      dR[i] = dR[i + 1] = dR[i + 2] = rv
      dR[i + 3] = 255
      const bv = clamp01(bump) * 255
      dB[i] = dB[i + 1] = dB[i + 2] = bv
      dB[i + 3] = 255
    }
  }
  gC.putImageData(iC, 0, 0)
  gR.putImageData(iR, 0, 0)
  gB.putImageData(iB, 0, 0)

  // железистые вкрапления в глазури
  const rr = mulberry32(41)
  const count = Math.round((S * S) / 900)
  const k = S / 1024
  for (let n = 0; n < count; n++) {
    const rad = Math.sqrt(rr()) * 1.66
    const ang = rr() * Math.PI * 2
    const [px, py] = toPx(Math.cos(ang) * rad, Math.sin(ang) * rad, S)
    const size = (0.4 + Math.pow(rr(), 5) * 2.2) * k
    const onRim = rad > 1.24
    if (onRim && rr() < 0.6) continue
    gC.fillStyle = onRim ? `rgba(150,112,76,${0.2 + rr() * 0.3})` : `rgba(86,56,36,${0.3 + rr() * 0.45})`
    gC.beginPath()
    gC.arc(px, py, size, 0, Math.PI * 2)
    gC.fill()
    gB.fillStyle = 'rgba(0,0,0,0.35)'
    gB.beginPath()
    gB.arc(px, py, size * 0.9, 0, Math.PI * 2)
    gB.fill()
    gR.fillStyle = 'rgba(255,255,255,0.2)'
    gR.beginPath()
    gR.arc(px, py, size, 0, Math.PI * 2)
    gR.fill()
  }
  // крупные пятна с ореолом
  for (let n = 0; n < 26; n++) {
    const rad = Math.sqrt(rr()) * 1.15
    const ang = rr() * Math.PI * 2
    const [px, py] = toPx(Math.cos(ang) * rad, Math.sin(ang) * rad, S)
    const size = (2 + rr() * 3) * k
    const grd = gC.createRadialGradient(px, py, 0, px, py, size * 2.4)
    grd.addColorStop(0, 'rgba(80,50,30,0.8)')
    grd.addColorStop(0.35, 'rgba(120,80,50,0.35)')
    grd.addColorStop(1, 'rgba(160,120,80,0)')
    gC.fillStyle = grd
    gC.beginPath()
    gC.arc(px, py, size * 2.4, 0, Math.PI * 2)
    gC.fill()
  }

  // контактные тени от еды
  const ao = bakeAO(food, S)
  gC.globalCompositeOperation = 'multiply'
  gC.drawImage(ao.sharp, 0, 0, S, S)
  gC.globalAlpha = 0.9
  gC.drawImage(ao.wide, 0, 0, S, S)
  gC.globalAlpha = 1
  gC.globalCompositeOperation = 'source-over'

  return {
    map: toTexture(cvC, { srgb: true, aniso }),
    rough: toTexture(cvR, { aniso }),
    bump: toTexture(cvB, { aniso }),
  }
}

function bakeAO(food, S) {
  const s = Math.round(S / 4)
  const acc = makeCanvas(s, s)
  const g = acc.getContext('2d')
  const v = new THREE.Vector3()
  for (const m of food) {
    const pos = m.geometry.attributes.position
    if (!m.geometry.boundingSphere) m.geometry.computeBoundingSphere()
    const worldR = m.geometry.boundingSphere.radius * m.getWorldScale(v).x
    // мелочам (соль, крошка) хватает нескольких точек, крупным объектам — до 1400
    const budget = Math.max(6, Math.min(1400, Math.round(worldR * 4000)))
    const step = Math.max(1, Math.floor(pos.count / budget))
    for (let i = 0; i < pos.count; i += step) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld)
      const h = v.y - WELL
      if (h < -0.02 || h > 0.45) continue
      const w = Math.exp(-Math.max(0, h) / 0.06)
      const [px, py] = toPx(v.x, v.z, s)
      const rad = Math.max(0.7, ((0.016 + Math.max(0, h) * 0.32) / (2 * E)) * s)
      g.fillStyle = `rgba(66,36,18,${(0.07 * w).toFixed(3)})`
      g.beginPath()
      g.arc(px, py, rad, 0, Math.PI * 2)
      g.fill()
    }
  }
  const sharp = makeCanvas(s, s)
  const gs = sharp.getContext('2d')
  gs.fillStyle = '#fff'
  gs.fillRect(0, 0, s, s)
  if ('filter' in gs) gs.filter = 'blur(1.2px)'
  gs.globalAlpha = 0.62
  gs.drawImage(acc, 0, 0)

  const ws = Math.max(8, Math.round(s / 6))
  const wide = makeCanvas(ws, ws)
  const gw = wide.getContext('2d')
  gw.fillStyle = '#fff'
  gw.fillRect(0, 0, ws, ws)
  gw.globalAlpha = 0.45
  gw.imageSmoothingQuality = 'high'
  gw.drawImage(acc, 0, 0, ws, ws)
  return { sharp, wide }
}

// ---------------------------------------------------------------------------
// pumpkin purée swoosh
// ---------------------------------------------------------------------------
function buildPuree({ N, hi }, micro) {
  const curve = new THREE.CatmullRomCurve3(
    [
      new THREE.Vector3(-0.6, 0, 0.4),
      new THREE.Vector3(-0.72, 0, -0.04),
      new THREE.Vector3(-0.52, 0, -0.47),
      new THREE.Vector3(-0.1, 0, -0.7),
      new THREE.Vector3(0.38, 0, -0.66),
    ],
    false,
    'centripetal',
  )
  const len = curve.getLength()
  const NT = hi ? 220 : 140
  const NS = hi ? 44 : 28
  const W0 = 0.3
  const H0 = 0.13
  const t0 = (W0 * 0.5) / len

  const pos = []
  const col = []
  const uv = []
  const base = new THREE.Color(0xd8721c)
  const light = new THREE.Color(0xeb9d48)
  const deep = new THREE.Color(0xc25a14)
  const c = new THREE.Color()
  const side = new THREE.Vector3()

  for (let it = 0; it <= NT; it++) {
    const t = it / NT
    const p = curve.getPointAt(t)
    const tan = curve.getTangentAt(t)
    side.set(-tan.z, 0, tan.x).normalize()
    let w = W0 * Math.pow(1 - t, 0.6) + 0.006
    let h = H0 * Math.pow(1 - t, 1.15) + 0.004 * (1 - t)
    if (t < t0) {
      const q = t / t0
      const cap = Math.sqrt(Math.max(0, 1 - (1 - q) * (1 - q)))
      w *= cap
      h *= Math.sqrt(cap)
    }
    w *= 1 - smooth(0.88, 1, t) * 0.9
    const grooveAmt = 0.45 * smooth(0.04, 0.22, t) * (1 - smooth(0.62, 0.97, t))

    for (let is = 0; is <= NS; is++) {
      const s = (is / NS) * 2 - 1
      const prof = Math.pow(Math.max(0, 1 - s * s), 0.42)
      const groove = grooveAmt * Math.exp(-(((s - 0.08) / 0.32) ** 2))
      const ridges = 0.06 * Math.sin(s * 26 + t * 4) * smooth(0.45, 1, t)
      const x = p.x + side.x * s * w * 0.5
      const z = p.z + side.z * s * w * 0.5
      const nn = N.noise3(x * 10, z * 10, s * 0.7) * 0.07
      let y = h * prof * (1 - groove + ridges + nn)
      y += h * 0.14 * Math.exp(-(((s - 0.55) / 0.13) ** 2)) * grooveAmt
      pos.push(x, WELL - 0.002 + Math.max(0, y), z)

      c.copy(base)
        .lerp(light, clamp01(prof * 0.55 - groove * 0.6 + nn * 2))
        .lerp(deep, clamp01(groove * 1.2 + (1 - prof) * 0.25))
      col.push(c.r, c.g, c.b)
      uv.push(t * len * 3, s * 0.4)
    }
  }
  const idx = []
  const row = NS + 1
  for (let it = 0; it < NT; it++) {
    for (let is = 0; is < NS; is++) {
      const a = it * row + is
      const b = a + row
      idx.push(a, b, a + 1, b, b + 1, a + 1)
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  g.setIndex(idx)
  g.computeVertexNormals()

  const bump = micro.clone()
  bump.repeat.set(2.5, 2.5)
  const mat = new THREE.MeshPhysicalMaterial({
    vertexColors: true,
    roughness: 0.4,
    clearcoat: 0.35,
    clearcoatRoughness: 0.35,
    sheen: 0.6,
    sheenColor: new THREE.Color(0xffb06a),
    sheenRoughness: 0.45,
    bumpMap: bump,
    bumpScale: 0.6,
    side: THREE.DoubleSide,
  })
  const mesh = new THREE.Mesh(g, mat)
  mesh.name = 'puree'
  return { mesh, curve }
}

// ---------------------------------------------------------------------------
// duck breast slices
// ---------------------------------------------------------------------------
function buildDuck({ N, rand, hi, aniso }, micro) {
  const L = 0.92
  const H = 0.25
  const T = 0.08
  const topFn = (u) => 0.03 + (H - 0.03) * Math.pow(Math.max(0, 1 - u * u), 0.62) * (1 - 0.12 * u)

  const shape = new THREE.Shape()
  const n = 44
  shape.moveTo(-L / 2, 0)
  for (let i = 0; i <= n; i++) {
    const u = -1 + (2 * i) / n
    shape.lineTo((u * L) / 2, topFn(u))
  }
  shape.lineTo(L / 2, 0)
  shape.lineTo(-L / 2, 0)

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: T,
    bevelEnabled: true,
    bevelThickness: 0.012,
    bevelSize: 0.01,
    bevelSegments: 3,
    steps: 1,
  })
  geo.translate(0, 0, -T / 2)

  // цвет боковин: хрустящая кожа сверху, обжаренное мясо снизу
  const pos = geo.attributes.position
  const colors = new Float32Array(pos.count * 3)
  const skinA = new THREE.Color(0x5a250d)
  const skinB = new THREE.Color(0x9a5420)
  const seared = new THREE.Color(0x7a4636)
  const c = new THREE.Color()
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    const y = pos.getY(i)
    const z = pos.getZ(i)
    const u = Math.max(-1, Math.min(1, x / (L / 2)))
    const dTop = topFn(u) - y
    if (dTop < 0.045) {
      c.copy(skinA).lerp(skinB, clamp01(0.45 + 0.6 * N.noise3(x * 30, y * 30, z * 30)))
    } else {
      c.copy(seared).lerp(skinA, clamp01(0.3 + 0.4 * N.noise3(x * 20, y * 20, z * 20)))
    }
    colors[i * 3] = c.r
    colors[i * 3 + 1] = c.g
    colors[i * 3 + 2] = c.b
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))

  const face = duckFaceTextures(N, topFn, L, H, hi ? 768 : 384, aniso)
  const faceMat = new THREE.MeshPhysicalMaterial({
    map: face.map,
    roughnessMap: face.rough,
    roughness: 1,
    bumpMap: face.bump,
    bumpScale: 1.4,
    clearcoat: 0.5,
    clearcoatRoughness: 0.32,
    sheen: 0.25,
    sheenColor: new THREE.Color(0xff9c8c),
  })
  const sideBump = micro.clone()
  sideBump.repeat.set(9, 9)
  const sideMat = new THREE.MeshPhysicalMaterial({
    vertexColors: true,
    roughness: 0.36,
    clearcoat: 0.8,
    clearcoatRoughness: 0.22,
    bumpMap: sideBump,
    bumpScale: 0.55,
  })

  // соль и перец на срезах
  const saltGeo = new THREE.BoxGeometry(0.014, 0.004, 0.013)
  const saltMat = new THREE.MeshPhysicalMaterial({ color: 0xf6f3ec, roughness: 0.22, clearcoat: 0.6 })
  const pepperGeo = new THREE.IcosahedronGeometry(0.0055, 0)
  const pepperMat = new THREE.MeshStandardMaterial({ color: 0x1c1410, roughness: 0.8 })

  const group = new THREE.Group()
  const meshes = []
  const slices = 5
  for (let i = 0; i < slices; i++) {
    const m = new THREE.Mesh(geo, [faceMat, sideMat])
    // ломтики лежат «черепицей»: срез смотрит вверх, каждый следующий сдвинут вдоль веера
    m.rotation.order = 'YXZ'
    m.rotation.set(-Math.PI / 2 + 0.42, (i - 2) * 0.09, 0)
    m.position.set((i - 2) * 0.075, WELL + 0.056, -0.3 + i * 0.15)
    m.castShadow = true
    m.receiveShadow = true
    m.name = 'duck-slice'

    const flakes = 2 + Math.floor(rand() * 3)
    for (let f = 0; f < flakes; f++) {
      const u = (rand() - 0.5) * 1.3
      const s = new THREE.Mesh(saltGeo, saltMat)
      s.position.set((u * L) / 2, 0.06 + rand() * (topFn(u) - 0.11), T / 2 + 0.014)
      s.rotation.set(Math.PI / 2 + (rand() - 0.5) * 0.4, rand() * 3, (rand() - 0.5) * 0.4)
      s.scale.setScalar(0.7 + rand() * 0.6)
      m.add(s)
    }
    for (let f = 0; f < 3; f++) {
      const u = (rand() - 0.5) * 1.4
      const p = new THREE.Mesh(pepperGeo, pepperMat)
      p.position.set((u * L) / 2, 0.05 + rand() * (topFn(u) - 0.09), T / 2 + 0.013)
      p.scale.set(1, 0.6, 1)
      m.add(p)
    }

    group.add(m)
    meshes.push(m)
  }
  group.position.set(0.22, 0, 0.1)
  group.rotation.y = 0.55
  return { group, meshes, topFn, L, H, T }
}

function duckFaceTextures(N, topFn, L, H, W, aniso) {
  const Hh = Math.round((W * (H + 0.02)) / (L + 0.02))
  const cvC = makeCanvas(W, Hh)
  const cvR = makeCanvas(W, Hh)
  const cvB = makeCanvas(W, Hh)
  const gC = cvC.getContext('2d')
  const gR = cvR.getContext('2d')
  const gB = cvB.getContext('2d')
  const iC = gC.createImageData(W, Hh)
  const iR = gR.createImageData(W, Hh)
  const iB = gB.createImageData(W, Hh)

  const skinA = hex(0x4c1f0c)
  const skinB = hex(0x8e4a1c)
  const fatA = hex(0xf1e3c6)
  const fatB = hex(0xe2c89c)
  const searedC = hex(0x5e3426)
  const grey = hex(0x86584c)
  const pink = hex(0x9a3a47)
  const center = hex(0xa84658)
  const out = [0, 0, 0]
  const tmp = [0, 0, 0]

  for (let py = 0; py < Hh; py++) {
    const y = (1 - (py + 0.5) / Hh) * (H + 0.02) - 0.01
    for (let px = 0; px < W; px++) {
      const x = ((px + 0.5) / W) * (L + 0.02) - (L / 2 + 0.01)
      const u = Math.max(-1, Math.min(1, x / (L / 2)))
      const dTop = topFn(u) - y
      const dBot = y
      const dEnd = L / 2 - Math.abs(x)
      const skinT = 0.011 + 0.003 * (N.noise2(x * 18, 1.5) * 0.5 + 0.5)
      const fatT = 0.018 + 0.006 * (N.noise2(x * 5, 4.2) * 0.5 + 0.5)
      let rough
      let bump
      if (dTop < skinT) {
        lerpC(skinA, skinB, clamp01(0.5 + 0.7 * N.noise2(x * 90, y * 90)), out)
        rough = 0.26
        bump = 0.5 + 0.25 * N.noise2(x * 140, y * 140)
      } else if (dTop < skinT + fatT) {
        const f = (dTop - skinT) / fatT
        lerpC(fatA, fatB, clamp01(0.4 + 0.5 * N.noise2(x * 40, y * 60)), out)
        lerpC(out, pink, smooth(0.75, 1, f) * 0.35, out)
        rough = 0.34
        bump = 0.55
      } else {
        const depth = Math.min(dTop - skinT - fatT, dBot, dEnd)
        if (depth < 0.006) {
          lerpC(searedC, grey, depth / 0.006, out)
        } else {
          lerpC(grey, pink, smooth(0.004, 0.045, depth), out)
          lerpC(out, center, smooth(0.05, 0.1, depth), tmp)
          out[0] = tmp[0]
          out[1] = tmp[1]
          out[2] = tmp[2]
        }
        // мышечные волокна вдоль ломтика
        const warp = N.noise2(x * 3, y * 18) * 0.35
        const fib = N.noise2(x * 6 + warp, y * 120) * 0.5 + 0.5
        const k = 1 - 0.1 * fib - 0.05 * (N.noise2(x * 60, y * 60) * 0.5 + 0.5)
        out[0] *= k
        out[1] *= k
        out[2] *= k
        rough = 0.4 - 0.12 * smooth(0.5, 0.9, N.noise2(x * 25, y * 25) * 0.5 + 0.5)
        bump = 0.5 + 0.18 * fib
      }
      const i = (py * W + px) * 4
      iC.data[i] = out[0]
      iC.data[i + 1] = out[1]
      iC.data[i + 2] = out[2]
      iC.data[i + 3] = 255
      iR.data[i] = iR.data[i + 1] = iR.data[i + 2] = clamp01(rough) * 255
      iR.data[i + 3] = 255
      iB.data[i] = iB.data[i + 1] = iB.data[i + 2] = clamp01(bump) * 255
      iB.data[i + 3] = 255
    }
  }
  gC.putImageData(iC, 0, 0)
  gR.putImageData(iR, 0, 0)
  gB.putImageData(iB, 0, 0)

  const mk = (cv, srgb) => {
    const t = toTexture(cv, { srgb, aniso })
    t.repeat.set(1 / (L + 0.02), 1 / (H + 0.02))
    t.offset.set(0.5, 0.01 / (H + 0.02))
    return t
  }
  return { map: mk(cvC, true), rough: mk(cvR, false), bump: mk(cvB, false) }
}

// ---------------------------------------------------------------------------
// roasted beetroot
// ---------------------------------------------------------------------------
function beetTexture(N, S, aniso) {
  const cv = makeCanvas(S, S)
  const g = cv.getContext('2d')
  const img = g.createImageData(S, S)
  const a = hex(0x5e0e33)
  const b = hex(0x34041a)
  const lightC = hex(0x7e1c47)
  const out = [0, 0, 0]
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = x / S - 0.32
      const dy = y / S - 0.64
      const d = Math.hypot(dx, dy)
      const warp = N.noise2(x * 0.02, y * 0.02) * 0.6
      const ring = Math.sin(d * 38 + warp * 3) * 0.5 + 0.5
      lerpC(b, a, 0.35 + ring * 0.4, out)
      lerpC(out, lightC, smooth(0.9, 1, ring) * 0.25, out)
      const k = 0.9 + 0.1 * N.noise2(x * 0.15, y * 0.15)
      const i = (y * S + x) * 4
      img.data[i] = out[0] * k
      img.data[i + 1] = out[1] * k
      img.data[i + 2] = out[2] * k
      img.data[i + 3] = 255
    }
  }
  g.putImageData(img, 0, 0)
  return toTexture(cv, { srgb: true, aniso })
}

function buildBeets({ N, rand, hi, aniso }, micro) {
  const map = beetTexture(N, hi ? 256 : 128, aniso)
  const bump = micro.clone()
  bump.repeat.set(1.5, 1.5)
  const mat = new THREE.MeshPhysicalMaterial({
    map,
    roughness: 0.42,
    clearcoat: 0.55,
    clearcoatRoughness: 0.25,
    bumpMap: bump,
    bumpScale: 0.5,
  })
  const spots = [
    [-0.2, 0.62], [0.04, 0.72], [-0.42, 0.5], [0.66, -0.22], [0.74, 0.1], [0.58, 0.46],
  ]
  const v = new THREE.Vector3()
  const nrm = new THREE.Vector3()
  return spots.map(([x, z], k) => {
    const sx = 0.1 + rand() * 0.04
    const sy = 0.085 + rand() * 0.03
    const sz = 0.1 + rand() * 0.04
    // печёная свёкла: неровные куски с подкопчёнными гранями, а не идеальные кубики
    const geo = new RoundedBoxGeometry(sx, sy, sz, 4, 0.03)
    const pos = geo.attributes.position
    const nor = geo.attributes.normal
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i)
      nrm.fromBufferAttribute(nor, i)
      const d = N.noise3(v.x * 9 + k * 7, v.y * 9, v.z * 9) * 0.007
      v.addScaledVector(nrm, d)
      // лёгкий скос верхней грани — как после ножа
      v.y += v.x * 0.12 * (k % 2 ? 1 : -1) * smooth(0, sy / 2, v.y)
      pos.setXYZ(i, v.x, v.y, v.z)
    }
    geo.computeVertexNormals()
    const m = new THREE.Mesh(geo, mat)
    m.position.set(x, WELL + sy / 2 - 0.004, z)
    m.rotation.set((rand() - 0.5) * 0.25, rand() * Math.PI, (rand() - 0.5) * 0.25)
    m.name = 'beet'
    return m
  })
}

// ---------------------------------------------------------------------------
// cherry jus + olive oil
// ---------------------------------------------------------------------------
function dropGeometry(segments = 40) {
  // единичная капля: плоский верх и мениск по краю
  const pts = [
    [1.02, 0], [1.0, 0.18], [0.96, 0.45], [0.88, 0.72], [0.74, 0.9], [0.5, 0.98], [0.2, 1], [0, 1],
  ].map(([r, y]) => new THREE.Vector2(r, y))
  return new THREE.LatheGeometry(pts, segments)
}

function buildSauce({ hi }) {
  const geo = dropGeometry(hi ? 48 : 28)
  const mat = new THREE.MeshPhysicalMaterial({
    color: 0x4a0812,
    roughness: 0.06,
    clearcoat: 1,
    clearcoatRoughness: 0.03,
    ior: 1.4,
    specularIntensity: 1,
  })
  const out = []
  // лужица соуса под уткой
  // соус лежит под веером утки и чуть выглядывает из-под ломтиков
  const pool = new THREE.Mesh(geo, mat)
  pool.scale.set(0.2, 0.01, 0.4)
  pool.position.set(0.24, WELL - 0.001, 0.1)
  pool.rotation.y = 0.55
  out.push(pool)
  const dots = [
    [0.4, 0.64, 0.046], [0.64, 0.34, 0.034], [-0.06, -0.38, 0.044], [0.17, -0.42, 0.03],
    [-0.5, 0.18, 0.034], [0.82, -0.44, 0.024], [-0.28, 0.74, 0.028], [0.9, 0.2, 0.02],
  ]
  dots.forEach(([x, z, r]) => {
    const m = new THREE.Mesh(geo, mat)
    m.scale.set(r, r * 0.42, r * (0.9 + (x * 13) % 0.2))
    m.position.set(x, WELL - 0.001, z)
    out.push(m)
  })
  return out
}

function buildOil({ hi, rand }) {
  const geo = dropGeometry(hi ? 32 : 20)
  const mat = hi
    ? new THREE.MeshPhysicalMaterial({
        color: 0xf2d566,
        roughness: 0.02,
        transmission: 1,
        thickness: 0.02,
        ior: 1.47,
        attenuationColor: new THREE.Color(0xc79a1c),
        attenuationDistance: 0.04,
        clearcoat: 1,
      })
    : new THREE.MeshPhysicalMaterial({
        color: 0xc9a227,
        roughness: 0.04,
        clearcoat: 1,
        transparent: true,
        opacity: 0.7,
      })
  const out = []
  for (let i = 0; i < 12; i++) {
    const a = rand() * Math.PI * 2
    const d = 0.3 + rand() * 0.55
    const r = 0.012 + rand() * 0.022
    const m = new THREE.Mesh(geo, mat)
    m.scale.set(r, r * 0.35, r)
    m.position.set(Math.cos(a) * d, WELL - 0.0005, Math.sin(a) * d)
    out.push(m)
  }
  return out
}

// ---------------------------------------------------------------------------
// garnish: hazelnut crumbs + microgreens
// ---------------------------------------------------------------------------
function crumbGeometry(N, seed) {
  const g = new THREE.IcosahedronGeometry(1, 1)
  const pos = g.attributes.position
  const v = new THREE.Vector3()
  const colors = new Float32Array(pos.count * 3)
  const inner = new THREE.Color(0xd2a46c)
  const skin = new THREE.Color(0x7a4824)
  const c = new THREE.Color()
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i)
    const d = 1 + N.noise3(v.x * 1.6 + seed, v.y * 1.6, v.z * 1.6) * 0.32
    v.multiplyScalar(d)
    pos.setXYZ(i, v.x, v.y, v.z)
    c.copy(inner).lerp(skin, smooth(-0.1, 0.25, N.noise3(v.x * 1.3 - seed, v.y * 1.3, v.z * 1.3)))
    colors[i * 3] = c.r
    colors[i * 3 + 1] = c.g
    colors[i * 3 + 2] = c.b
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  g.computeVertexNormals()
  return g
}

function leafTexture(N, S, palette, aniso) {
  const cv = makeCanvas(S, S)
  const g = cv.getContext('2d')
  const img = g.createImageData(S, S)
  const [edgeC, midC, ribC] = palette.map(hex)
  const out = [0, 0, 0]
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = (x / S) * 2 - 1 // поперёк листа
      const v = 1 - y / S // вдоль листа
      const edge = smooth(0.35, 1, Math.abs(u))
      lerpC(midC, edgeC, edge, out)
      const rib = Math.exp(-((u / 0.05) ** 2)) * smooth(0, 0.1, v) * (1 - smooth(0.8, 1, v))
      lerpC(out, ribC, rib * 0.7, out)
      const vq = ((Math.abs(u) * 0.9 - (v - 0.15) * 0.8) % 0.22) / 0.02
      const veins = Math.exp(-(vq * vq)) * (1 - edge)
      lerpC(out, ribC, veins * 0.25, out)
      const k = 0.92 + 0.08 * N.noise2(x * 0.2, y * 0.2)
      const i = (y * S + x) * 4
      img.data[i] = out[0] * k
      img.data[i + 1] = out[1] * k
      img.data[i + 2] = out[2] * k
      img.data[i + 3] = 255
    }
  }
  g.putImageData(img, 0, 0)
  return toTexture(cv, { srgb: true, aniso })
}

function leafGeometry(len, wid) {
  const s = new THREE.Shape()
  s.moveTo(0, 0)
  s.bezierCurveTo(wid * 0.95, len * 0.08, wid * 0.85, len * 0.92, 0, len)
  s.bezierCurveTo(-wid * 0.85, len * 0.92, -wid * 0.95, len * 0.08, 0, 0)
  const g = new THREE.ShapeGeometry(s, 12)
  const pos = g.attributes.position
  const uv = g.attributes.uv
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    const y = pos.getY(i)
    pos.setZ(i, (x / wid) ** 2 * wid * 0.35 + (y / len) ** 2 * len * 0.22)
    uv.setXY(i, x / (2 * wid) + 0.5, y / len)
  }
  g.computeVertexNormals()
  return g
}

function buildSprig(rand, mats, leafGeo) {
  const g = new THREE.Group()
  const hgt = 0.04 + rand() * 0.05
  const bend = (rand() - 0.5) * 0.04
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(bend * 0.5, hgt * 0.5, bend * 0.3),
    new THREE.Vector3(bend, hgt, 0),
  ])
  const stem = new THREE.Mesh(new THREE.TubeGeometry(curve, 10, 0.0032, 5, false), mats.stem)
  g.add(stem)
  const tip = curve.getPoint(1)
  const leaves = 2
  const base = rand() * Math.PI
  for (let i = 0; i < leaves; i++) {
    const pivot = new THREE.Group()
    pivot.position.copy(tip)
    pivot.rotation.y = base + i * Math.PI + (rand() - 0.5) * 0.3
    const leaf = new THREE.Mesh(leafGeo, mats.leaf)
    leaf.rotation.x = -1.1 - rand() * 0.35 // лист раскрыт вверх-наружу
    leaf.scale.setScalar(0.85 + rand() * 0.35)
    pivot.add(leaf)
    g.add(pivot)
  }
  return g
}

function buildGarnish({ N, rand, hi, aniso }, micro, surfaces, puree, duck) {
  const out = []

  // фундук
  const crumbMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.72 })
  const crumbGeos = [0, 1, 2, 3].map((s) => crumbGeometry(N, s * 3.1))
  const placeCrumb = (x, z) => {
    const hit = dropOnto(surfaces, x, z)
    if (!hit) return
    const m = new THREE.Mesh(crumbGeos[Math.floor(rand() * crumbGeos.length)], crumbMat)
    const s = 0.016 + rand() * 0.016
    m.scale.set(s * (0.9 + rand() * 0.5), s * (0.6 + rand() * 0.3), s * (0.9 + rand() * 0.5))
    m.rotation.set(rand() * 3, rand() * 3, rand() * 3)
    m.position.copy(hit.point).addScaledVector(hit.normal, s * 0.4)
    out.push(m)
  }
  for (let i = 0; i < 18; i++) {
    const p = puree.curve.getPointAt(0.05 + rand() * 0.6)
    placeCrumb(p.x + (rand() - 0.5) * 0.16, p.z + (rand() - 0.5) * 0.16)
  }
  for (let i = 0; i < 6; i++) {
    const a = rand() * Math.PI * 2
    const d = 0.45 + rand() * 0.4
    placeCrumb(Math.cos(a) * d, Math.sin(a) * d)
  }

  // микрозелень: зелёный кресс и красный амарант
  const S = hi ? 128 : 64
  const green = {
    leaf: new THREE.MeshPhysicalMaterial({
      map: leafTexture(N, S, [0x3f6a1f, 0x6c9a34, 0xb9d27a], aniso),
      roughness: 0.48,
      sheen: 0.6,
      sheenColor: new THREE.Color(0xd8f0a8),
      sheenRoughness: 0.4,
      side: THREE.DoubleSide,
    }),
    stem: new THREE.MeshStandardMaterial({ color: 0xc8d796, roughness: 0.55 }),
  }
  const red = {
    leaf: new THREE.MeshPhysicalMaterial({
      map: leafTexture(N, S, [0x4a0f26, 0x7d1d3f, 0xb04a6a], aniso),
      roughness: 0.45,
      sheen: 0.5,
      sheenColor: new THREE.Color(0xf0a0c0),
      side: THREE.DoubleSide,
    }),
    stem: new THREE.MeshStandardMaterial({ color: 0xc46a86, roughness: 0.55 }),
  }
  const leafG = leafGeometry(0.095, 0.052)
  const spots = [
    { x: 0.16, z: 0.04, mats: green, n: 4 },
    { x: 0.36, z: 0.2, mats: red, n: 3 },
    { x: -0.62, z: 0.1, mats: green, n: 3 },
    { x: -0.3, z: -0.56, mats: red, n: 3 },
    { x: 0.04, z: -0.66, mats: green, n: 2 },
  ]
  spots.forEach(({ x, z, mats, n }) => {
    // пучок ростков; каждый «падает» на ближайшую верхнюю поверхность
    for (let i = 0; i < n; i++) {
      const hit = dropOnto(surfaces, x + (rand() - 0.5) * 0.07, z + (rand() - 0.5) * 0.07)
      if (!hit) continue
      const s = buildSprig(rand, mats, leafG)
      s.position.copy(hit.point)
      s.rotation.set((rand() - 0.5) * 1.1, rand() * Math.PI * 2, (rand() - 0.5) * 1.1)
      out.push(s)
    }
  })
  return out
}
