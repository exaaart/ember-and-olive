import * as THREE from 'three'
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { createNoise, mulberry32, smooth, clamp01 } from './noise.js'
import {
  duckSkinScore,
  duckTopProfile,
  getDuckSliceSpecs,
  heightBufferToNormalRGBA,
  plateSurfaceY,
} from './dishMath.js'

/**
 * Процедурное блюдо «утиная грудка с углей» (fine-dining версия):
 * - керамическая тарелка ручной работы с реактивной глазурью и гончарными кольцами (PBR + NormalMap)
 * - 5 анатомически разных ломтиков утиной грудки с ромбовидной насечкой на хрустящей коже
 *   и реалистичной текстурой medium-rare среза (Albedo + Roughness + NormalMap)
 * - шелковистое тыквенное пюре с вкраплениями коричневого масла
 * - рубленые клинья печёной свёклы с подпалинами из дровяной печи
 * - обожжённые лепестки красного шалота
 * - зеркальный вишнёвый демиглас + капли зелёного оливкового масла (InstancedMesh, без transmission-прохода)
 * - дроблёный жареный фундук, хлопья соли Maldon, дроблёный перец и тонкая микрозелень
 *
 * Масштаб: 1 единица ≈ 8 см (тарелка ~27 см).
 */

const WELL = 0.062
const E = 1.72

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

function heightToNormalTexture(heights, w, h, { strength = 2.0, aniso = 1, wrap = THREE.ClampToEdgeWrapping } = {}) {
  const rgba = heightBufferToNormalRGBA(heights, w, h, strength, wrap !== THREE.ClampToEdgeWrapping)
  const tex = new THREE.DataTexture(rgba, w, h, THREE.RGBAFormat)
  tex.colorSpace = THREE.NoColorSpace
  tex.anisotropy = aniso
  tex.wrapS = tex.wrapT = wrap
  tex.generateMipmaps = true
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.flipY = true
  tex.needsUpdate = true
  return tex
}

const toPx = (x, z, S) => [(x / (2 * E) + 0.5) * S, (0.5 - z / (2 * E)) * S]

const _ray = new THREE.Raycaster()
const _down = new THREE.Vector3(0, -1, 0)
const _origin = new THREE.Vector3()
const _mat4 = new THREE.Matrix4()
const _quat = new THREE.Quaternion()
const _euler = new THREE.Euler()
const _scale = new THREE.Vector3()
const _pos = new THREE.Vector3()
const _color = new THREE.Color()

function dropOnto(surfaces, x, z) {
  _origin.set(x, 3, z)
  _ray.set(_origin, _down)
  const hit = _ray.intersectObjects(surfaces, false)[0]
  if (!hit) {
    const r = Math.hypot(x, z)
    return {
      point: new THREE.Vector3(x, plateSurfaceY(r, WELL), z),
      normal: new THREE.Vector3(0, 1, 0),
      object: null,
    }
  }
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

  const micro = buildMicroMaps(N, hi ? 256 : 128, anisotropy)

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

  const sauce = buildSauce(ctx, micro)
  sauce.meshes.forEach((m) => addFood(m, { cast: false }))

  const puree = buildPuree(ctx, micro)
  addFood(puree.mesh)

  const duck = buildDuck(ctx, micro)
  dish.add(duck.group)
  duck.meshes.forEach((m) => food.push(m))

  const beets = buildBeets(ctx, micro)
  beets.forEach((m) => addFood(m))

  const shallots = buildShallots(ctx, micro)
  shallots.forEach((m) => addFood(m))

  const oil = buildOil(ctx, sauce.poolCenter)
  oil.forEach((m) => addFood(m, { cast: false }))

  dish.updateMatrixWorld(true)

  // гарнир «падает» на поверхности сверху — ничего не висит в воздухе
  const surfaces = [puree.mesh, ...duck.meshes, ...beets, ...shallots]
  const garnish = buildGarnish(ctx, surfaces, puree, duck)
  garnish.forEach((o) => {
    dish.add(o)
    o.traverse((c) => {
      if (c.isMesh) {
        c.castShadow = !c.isInstancedMesh || c.userData.castShadow !== false
        c.receiveShadow = true
        if (!c.isInstancedMesh) food.push(c)
      }
    })
  })
  dish.updateMatrixWorld(true)

  // направленные контактные тени, запечённые в глазурь тарелки
  plate.applyTextures(food)

  return dish
}

// ---------------------------------------------------------------------------
// shared micro detail (bump + normal)
// ---------------------------------------------------------------------------
function buildMicroMaps(N, S, aniso) {
  const heights = new Float32Array(S * S)
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      heights[y * S + x] = 0.5 + 0.5 * N.fbm2(x * 0.055 + 42, y * 0.055, 4)
    }
  }
  const normal = heightToNormalTexture(heights, S, S, {
    strength: 1.5,
    aniso,
    wrap: THREE.MirroredRepeatWrapping,
  })
  return { normal }
}

// ---------------------------------------------------------------------------
// stoneware ceramic plate (reactive glaze + potter's wheel rings + directional AO)
// ---------------------------------------------------------------------------
const TOP_PROFILE = [
  [1.61, 0.132], [1.64, 0.144], [1.65, 0.16], [1.638, 0.174], [1.612, 0.181], [1.555, 0.178],
  [1.45, 0.165], [1.29, 0.138], [1.11, 0.104], [0.95, 0.079], [0.78, 0.068], [0.5, 0.064], [0.22, 0.0625], [0, WELL],
]
const UNDER_PROFILE = [
  [0, 0.025], [0.3, 0.023], [0.54, 0.015], [0.585, 0.003], [0.635, 0], [0.678, 0.007], [0.695, 0.036],
  [0.84, 0.049], [1.14, 0.078], [1.44, 0.111], [1.61, 0.132],
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

  // ручная лепка: деликатная волна борта и лёгкая овальность
  const pos = g.attributes.position
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    const y = pos.getY(i)
    const z = pos.getZ(i)
    const r = Math.hypot(x, z)
    if (r < 1e-5) continue
    const ca = x / r
    const sa = z / r
    const k = smooth(0.9, 1.62, r)
    const wob = N.noise2(ca * 1.4 + 3, sa * 1.4) * 0.0085 + N.noise2(ca * 4.2 + 1, sa * 4.2 + 7) * 0.0024
    const rs = 1 + N.noise2(ca * 1.2 + 11, sa * 1.2 - 2) * 0.005 * k
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
  const segs = hi ? 160 : 112
  const glazeMat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    roughness: 1,
    clearcoat: 0.68,
    clearcoatRoughness: 0.11,
    specularIntensity: 0.75,
    envMapIntensity: 1.05,
  })
  const clayMat = new THREE.MeshStandardMaterial({
    color: 0x7a5038,
    roughness: 0.92,
    metalness: 0.02,
  })

  const top = new THREE.Mesh(latheGeo(TOP_PROFILE, segs, N), glazeMat)
  const under = new THREE.Mesh(latheGeo(UNDER_PROFILE, segs, N), clayMat)
  ;[top, under].forEach((m) => {
    m.castShadow = true
    m.receiveShadow = true
  })
  const group = new THREE.Group()
  group.add(top, under)

  function applyTextures(food) {
    const S = hi ? 640 : 448
    const t = plateTextures(N, S, food, aniso)
    glazeMat.map = t.map
    glazeMat.roughnessMap = t.rough
    glazeMat.normalMap = t.normal
    glazeMat.normalScale = new THREE.Vector2(0.42, 0.42)
    glazeMat.needsUpdate = true

    clayMat.normalMap = t.normal
    clayMat.normalScale = new THREE.Vector2(0.8, 0.8)
    clayMat.needsUpdate = true
  }

  return { group, top, applyTextures }
}

function plateTextures(N, S, food, aniso) {
  const cvC = makeCanvas(S, S)
  const cvR = makeCanvas(S, S)
  const gC = cvC.getContext('2d')
  const gR = cvR.getContext('2d')
  const iC = gC.createImageData(S, S)
  const iR = gR.createImageData(S, S)
  const dC = iC.data
  const dR = iR.data
  const heights = new Float32Array(S * S)

  // тёплый благородный оттенок каменной керамики — мягко держит свет без пересвета
  const stoneLight = hex(0xd9c8b1)
  const stoneMid = hex(0xc6b399)
  const stoneWarm = hex(0xbba284)
  const glazeDark = hex(0x1f1611)
  const glazeUmber = hex(0x3a281d)
  const glazeOlive = hex(0x363626)
  const rustBreak = hex(0x7c4829)
  const lipClay = hex(0x5e3c28)
  const tmp = [0, 0, 0]
  const tmp2 = [0, 0, 0]

  const BINS = 1024
  const rbLut = new Float32Array(BINS)
  for (let b = 0; b < BINS; b++) {
    const a = (b / BINS) * Math.PI * 2
    rbLut[b] = 1.18 + 0.032 * N.fbm2(Math.cos(a) * 1.9 + 5, Math.sin(a) * 1.9 - 3, 3)
  }
  const RMAX = 1.69

  for (let py = 0; py < S; py++) {
    const z = (0.5 - (py + 0.5) / S) * 2 * E
    for (let px = 0; px < S; px++) {
      const x = ((px + 0.5) / S - 0.5) * 2 * E
      const r = Math.hypot(x, z)
      const pIdx = py * S + px
      const i = pIdx * 4

      if (r > RMAX) {
        dC[i] = lipClay[0]
        dC[i + 1] = lipClay[1]
        dC[i + 2] = lipClay[2]
        dC[i + 3] = 255
        dR[i] = dR[i + 1] = dR[i + 2] = 110
        dR[i + 3] = 255
        heights[pIdx] = 0.5
        continue
      }

      const inv = r > 1e-4 ? 1 / r : 0
      const ca = x * inv
      const sa = z * inv

      // тонкие гончарные кольца от круга + естественная тональность обжига
      const wheelRing = Math.sin(r * 52 + N.noise2(ca * 2, sa * 2) * 0.9) * 0.5 + 0.5
      const lf = N.fbm2(x * 1.35 + 10, z * 1.35, 3) * 0.5 + 0.5
      const radialTone = smooth(0.15, 1.15, r)

      lerpC(stoneLight, stoneMid, clamp01(lf * 0.65 + radialTone * 0.35), tmp)
      lerpC(tmp, stoneWarm, smooth(0.55, 0.95, wheelRing) * 0.14, tmp)

      let rough = 0.34 + 0.08 * lf - 0.03 * wheelRing
      let h = 0.5 + 0.045 * (wheelRing - 0.5) + 0.025 * N.noise2(x * 55, z * 55)

      let ang = Math.atan2(z, x)
      if (ang < 0) ang += Math.PI * 2
      const rb =
        rbLut[Math.min(BINS - 1, Math.floor((ang / (Math.PI * 2)) * BINS))] +
        0.014 * N.fbm2(x * 11, z * 11, 2)

      if (r > rb - 0.09) {
        // мягкий органический перелив реактивной глазури
        const k = smooth(rb - 0.055, rb + 0.085, r)
        const streak = N.fbm3(ca * 3.2, sa * 3.2, r * 2.5, 3) * 0.5 + 0.5
        const streak2 = N.noise3(ca * 8.5 + 3, sa * 8.5, r * 3.4) * 0.5 + 0.5
        lerpC(glazeDark, glazeUmber, smooth(0.2, 0.82, streak), tmp2)
        lerpC(tmp2, glazeOlive, smooth(0.55, 0.95, streak2) * 0.48, tmp2)

        const kilnEdge = smooth(rb - 0.06, rb + 0.015, r) * (1 - smooth(rb + 0.015, rb + 0.11, r))
        lerpC(tmp2, rustBreak, kilnEdge * 0.72, tmp2)

        const lip = smooth(1.56, 1.655, r)
        lerpC(tmp2, lipClay, lip * 0.78, tmp2)

        lerpC(tmp, tmp2, k, tmp)
        // тёмная глазурь на борту чуть более глянцевая, а открытая глина кромки — матовая
        const rimRough = 0.14 + 0.07 * streak + kilnEdge * 0.1 + lip * 0.42
        rough = rough * (1 - k) + rimRough * k
        h += ((streak2 - 0.5) * 0.12 + kilnEdge * 0.09) * k
      }

      dC[i] = tmp[0]
      dC[i + 1] = tmp[1]
      dC[i + 2] = tmp[2]
      dC[i + 3] = 255

      const rv = clamp01(rough) * 255
      dR[i] = dR[i + 1] = dR[i + 2] = rv
      dR[i + 3] = 255
      heights[pIdx] = clamp01(h)
    }
  }
  gC.putImageData(iC, 0, 0)
  gR.putImageData(iR, 0, 0)

  // железистые вкрапления каменной глины (выступающие из обжига)
  const rr = mulberry32(41)
  const count = Math.round((S * S) / 760)
  const kScale = S / 1024
  for (let n = 0; n < count; n++) {
    const rad = Math.sqrt(rr()) * 1.65
    const ang = rr() * Math.PI * 2
    const [px, py] = toPx(Math.cos(ang) * rad, Math.sin(ang) * rad, S)
    const size = (0.45 + Math.pow(rr(), 4.5) * 2.1) * kScale
    const onRim = rad > 1.2
    if (onRim && rr() < 0.55) continue
    gC.fillStyle = onRim
      ? `rgba(145,104,68,${0.18 + rr() * 0.25})`
      : `rgba(74,48,30,${0.26 + rr() * 0.42})`
    gC.beginPath()
    gC.arc(px, py, size, 0, Math.PI * 2)
    gC.fill()

    // небольшая ямка в карте высот и шероховатости
    const ix = Math.round(px)
    const iy = Math.round(py)
    if (ix >= 0 && ix < S && iy >= 0 && iy < S) {
      heights[iy * S + ix] = Math.max(0, heights[iy * S + ix] - 0.18)
    }
    gR.fillStyle = 'rgba(255,255,255,0.22)'
    gR.beginPath()
    gR.arc(px, py, size, 0, Math.PI * 2)
    gR.fill()
  }

  // деликатные ореолы обжига железа
  for (let n = 0; n < 22; n++) {
    const rad = Math.sqrt(rr()) * 1.12
    const ang = rr() * Math.PI * 2
    const [px, py] = toPx(Math.cos(ang) * rad, Math.sin(ang) * rad, S)
    const size = (1.6 + rr() * 2.6) * kScale
    const grd = gC.createRadialGradient(px, py, 0, px, py, size * 2.5)
    grd.addColorStop(0, 'rgba(68,42,24,0.72)')
    grd.addColorStop(0.38, 'rgba(110,74,46,0.26)')
    grd.addColorStop(1, 'rgba(140,104,72,0)')
    gC.fillStyle = grd
    gC.beginPath()
    gC.arc(px, py, size * 2.5, 0, Math.PI * 2)
    gC.fill()
  }

  // направленные и контактные тени от всей еды (совпадают с направлением key-света)
  const ao = bakeAO(food, S)
  gC.globalCompositeOperation = 'multiply'
  gC.drawImage(ao.crevice, 0, 0, S, S)
  gC.globalAlpha = 0.92
  gC.drawImage(ao.directional, 0, 0, S, S)
  gC.globalAlpha = 1
  gC.globalCompositeOperation = 'source-over'

  const normal = heightToNormalTexture(heights, S, S, { strength: 2.2, aniso })

  return {
    map: toTexture(cvC, { srgb: true, aniso }),
    rough: toTexture(cvR, { aniso }),
    normal,
  }
}

function bakeAO(food, S) {
  const s = Math.round(S / 3)
  const accTight = makeCanvas(s, s)
  const accDir = makeCanvas(s, s)
  const gT = accTight.getContext('2d')
  const gD = accDir.getContext('2d')
  const v = new THREE.Vector3()
  const sc = new THREE.Vector3()

  // key light в dishScene стоит в (-3.3, 4.1, 1.85) -> тень падает в (+0.42, -0.24) от высоты
  const dirX = 0.42
  const dirZ = -0.24

  for (const m of food) {
    if (!m.geometry || !m.geometry.attributes?.position) continue
    const pos = m.geometry.attributes.position
    if (!m.geometry.boundingSphere) m.geometry.computeBoundingSphere()
    const worldR = m.geometry.boundingSphere.radius * m.getWorldScale(sc).x
    const budget = Math.max(8, Math.min(1200, Math.round(worldR * 3600)))
    const step = Math.max(1, Math.floor(pos.count / budget))

    for (let i = 0; i < pos.count; i += step) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld)
      const h = v.y - plateSurfaceY(Math.hypot(v.x, v.z), WELL)
      if (h < -0.02 || h > 0.42) continue

      // плотный контактный AO прямо под едой
      const wTight = Math.exp(-Math.max(0, h) / 0.045)
      if (wTight > 0.04) {
        const [px, py] = toPx(v.x, v.z, s)
        const rad = Math.max(0.8, ((0.015 + Math.max(0, h) * 0.22) / (2 * E)) * s)
        gT.fillStyle = `rgba(38,20,12,${(0.11 * wTight).toFixed(3)})`
        gT.beginPath()
        gT.arc(px, py, rad, 0, Math.PI * 2)
        gT.fill()
      }

      // мягкая направленная падающая тень на глазурь
      const wDir = Math.exp(-Math.max(0, h) / 0.22)
      const sx = v.x + Math.max(0, h) * dirX
      const sz = v.z + Math.max(0, h) * dirZ
      const [dx, dy] = toPx(sx, sz, s)
      const radD = Math.max(1.2, ((0.032 + Math.max(0, h) * 0.36) / (2 * E)) * s)
      gD.fillStyle = `rgba(48,28,18,${(0.055 * wDir).toFixed(3)})`
      gD.beginPath()
      gD.arc(dx, dy, radD, 0, Math.PI * 2)
      gD.fill()
    }
  }

  const crevice = makeCanvas(s, s)
  const gc = crevice.getContext('2d')
  gc.fillStyle = '#fff'
  gc.fillRect(0, 0, s, s)
  if ('filter' in gc) gc.filter = 'blur(1.4px)'
  gc.globalAlpha = 0.72
  gc.drawImage(accTight, 0, 0)

  const ds = Math.max(16, Math.round(s / 4))
  const directional = makeCanvas(ds, ds)
  const gd = directional.getContext('2d')
  gd.fillStyle = '#fff'
  gd.fillRect(0, 0, ds, ds)
  gd.globalAlpha = 0.56
  gd.imageSmoothingQuality = 'high'
  gd.drawImage(accDir, 0, 0, ds, ds)

  return { crevice, directional }
}

// ---------------------------------------------------------------------------
// silky roasted pumpkin & brown-butter purée swoosh
// ---------------------------------------------------------------------------
function buildPuree({ N, hi, aniso }) {
  const curve = new THREE.CatmullRomCurve3(
    [
      new THREE.Vector3(-0.62, 0, 0.38),
      new THREE.Vector3(-0.74, 0, -0.05),
      new THREE.Vector3(-0.54, 0, -0.49),
      new THREE.Vector3(-0.1, 0, -0.71),
      new THREE.Vector3(0.42, 0, -0.64),
    ],
    false,
    'centripetal',
  )
  const len = curve.getLength()
  const NT = hi ? 180 : 120
  const NS = hi ? 40 : 26
  const W0 = 0.33
  const H0 = 0.118
  const t0 = (W0 * 0.52) / len

  const pos = []
  const col = []
  const uv = []
  const base = new THREE.Color(0xdc6d18)
  const light = new THREE.Color(0xf49d40)
  const deep = new THREE.Color(0xb24a0d)
  const c = new THREE.Color()
  const side = new THREE.Vector3()

  for (let it = 0; it <= NT; it++) {
    const t = it / NT
    const p = curve.getPointAt(t)
    const tan = curve.getTangentAt(t)
    side.set(-tan.z, 0, tan.x).normalize()

    let w = W0 * Math.pow(1 - t, 0.62) + 0.006
    let h = H0 * Math.pow(1 - t, 1.12) + 0.004 * (1 - t)
    if (t < t0) {
      const q = t / t0
      const cap = Math.sqrt(Math.max(0, 1 - (1 - q) * (1 - q)))
      w *= cap
      h *= Math.sqrt(cap)
    }
    w *= 1 - smooth(0.86, 1, t) * 0.92
    const grooveAmt = 0.46 * smooth(0.03, 0.2, t) * (1 - smooth(0.6, 0.96, t))

    for (let is = 0; is <= NS; is++) {
      const s = (is / NS) * 2 - 1
      const prof = Math.pow(Math.max(0, 1 - s * s), 0.44)
      // характерная ложбинка от ложки шефа + тонкие продольные борозды
      const groove = grooveAmt * Math.exp(-(((s - 0.06) / 0.34) ** 2))
      const ridges = 0.055 * Math.sin(s * 28 + t * 5) * smooth(0.32, 1, t)
      const x = p.x + side.x * s * w * 0.5
      const z = p.z + side.z * s * w * 0.5
      const nn = N.noise3(x * 9, z * 9, s * 0.7) * 0.055
      let y = h * prof * (1 - groove + ridges + nn)
      // чуть приподнятые бортики мазка по краям ложбинки
      y += h * 0.16 * Math.exp(-(((s - 0.56) / 0.14) ** 2)) * grooveAmt
      y += h * 0.1 * Math.exp(-(((s + 0.5) / 0.16) ** 2)) * grooveAmt

      const floorY = plateSurfaceY(Math.hypot(x, z), WELL)
      pos.push(x, floorY - 0.002 + Math.max(0, y), z)

      c.copy(base)
        .lerp(light, clamp01(prof * 0.54 - groove * 0.42 + nn * 1.6))
        .lerp(deep, clamp01(groove * 0.85 + (1 - prof) * 0.22))
      col.push(c.r, c.g, c.b)
      uv.push(t * len * 2.6, s * 0.5 + 0.5)
    }
  }

  const idx = []
  const row = NS + 1
  for (let it = 0; it < NT; it++) {
    for (let is = 0; is < NS; is++) {
      const a = it * row + is
      const b = a + row
      // правильный порядок вершин (CCW сверху): нормали смотрят строго вверх (+Y)
      idx.push(a, a + 1, b, b, a + 1, b + 1)
    }
  }

  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  g.setIndex(idx)
  g.computeVertexNormals()

  // текстура пюре: тонкие следы ложки + микровкрапления коричневого масла и мускатного ореха
  const S = hi ? 256 : 128
  const cv = makeCanvas(S, S)
  const ctx2 = cv.getContext('2d')
  const img = ctx2.createImageData(S, S)
  const heights = new Float32Array(S * S)
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = x / S
      const v = y / S
      const streak = Math.sin(v * Math.PI * 24 + N.noise2(u * 4, v * 4) * 1.5) * 0.5 + 0.5
      const grain = N.fbm2(u * 26, v * 26, 3) * 0.5 + 0.5
      const speck = smooth(0.79, 0.92, N.noise2(u * 62 + 9, v * 62 - 4) * 0.5 + 0.5)
      const shade = 0.94 + 0.08 * streak - 0.24 * speck
      const i = (y * S + x) * 4
      img.data[i] = clamp01(shade) * 255
      img.data[i + 1] = clamp01(shade * (1 - speck * 0.18)) * 255
      img.data[i + 2] = clamp01(shade * (1 - speck * 0.35)) * 255
      img.data[i + 3] = 255
      heights[y * S + x] = 0.5 + 0.22 * (streak - 0.5) + 0.14 * (grain - 0.5)
    }
  }
  ctx2.putImageData(img, 0, 0)
  const map = toTexture(cv, { srgb: true, aniso, wrap: THREE.RepeatWrapping })
  const normal = heightToNormalTexture(heights, S, S, { strength: 1.6, aniso, wrap: THREE.RepeatWrapping })

  const mat = new THREE.MeshPhysicalMaterial({
    vertexColors: true,
    map,
    normalMap: normal,
    normalScale: new THREE.Vector2(0.55, 0.55),
    roughness: 0.28,
    clearcoat: 0.58,
    clearcoatRoughness: 0.18,
    sheen: 0.45,
    sheenColor: new THREE.Color(0xffb56b),
    sheenRoughness: 0.4,
    side: THREE.DoubleSide,
  })
  const mesh = new THREE.Mesh(g, mat)
  mesh.name = 'puree'
  return { mesh, curve }
}

// ---------------------------------------------------------------------------
// anatomical sculpted duck breast slices (medium-rare + diamond-scored crispy skin)
// ---------------------------------------------------------------------------
function buildDuckSliceGeometry(N, spec, L, H, T) {
  const sL = L * spec.lengthScale
  const sH = H * spec.heightScale
  const sT = T * spec.thicknessScale
  const topFn = (u) => duckTopProfile(u, sH)

  const shape = new THREE.Shape()
  const n = 48
  shape.moveTo(-sL / 2, 0)
  for (let i = 0; i <= n; i++) {
    const u = -1 + (2 * i) / n
    const edgeRipple = N.noise2(u * 4.5 + spec.index * 3.7, spec.index * 1.9) * 0.0055 * (1 - u * u)
    shape.lineTo((u * sL) / 2, Math.max(0.014, topFn(u) + edgeRipple))
  }
  shape.lineTo(sL / 2, 0)
  shape.lineTo(-sL / 2, 0)

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: sT,
    bevelEnabled: true,
    bevelThickness: 0.013,
    bevelSize: 0.011,
    bevelSegments: 4,
    steps: 4,
  })
  geo.translate(0, 0, -sT / 2)

  // органическая 3D-скульптура: лёгкий изгиб ломтика + физическая насечка на коже
  const pos = geo.attributes.position
  const uv = geo.attributes.uv
  const colors = new Float32Array(pos.count * 3)

  const skinDark = new THREE.Color(0x3a1506)
  const skinAmber = new THREE.Color(0x8c4617)
  const fatGold = new THREE.Color(0xc98a42)
  const seared = new THREE.Color(0x52291c)
  const searedDeep = new THREE.Color(0x2f140c)
  const c = new THREE.Color()

  const seed = spec.index * 5.13
  for (let i = 0; i < pos.count; i++) {
    let x = pos.getX(i)
    let y = pos.getY(i)
    let z = pos.getZ(i)
    const u = Math.max(-1, Math.min(1, x / (sL / 2)))
    const dTop = topFn(u) - y

    // естественный изгиб и плавное сужение толщины к краям ломтика (без эффекта «прямоугольных брусков» со спины)
    const endTaper = 0.68 + 0.32 * Math.sqrt(Math.max(0.06, 1 - u * u))
    z *= endTaper
    const archBend = -spec.slump * u * u
    const organic = N.noise3(x * 7 + seed, y * 7, z * 7) * 0.0045
    z += archBend + organic * 0.65
    y += organic * 0.45

    // ромбовидная насечка по хрустящей утиной коже (на верхней дуге)
    let score = 0
    if (dTop < 0.036) {
      score = duckSkinScore(x + spec.index * 0.031, z + spec.index * 0.019, 0.088)
      const skinBlend = 1 - smooth(0.012, 0.036, dTop)
      // прорезаем тонкую канавку и слегка вспучиваем «ромбики» между разрезами
      const puff = (0.38 - score) * 0.0095 * skinBlend
      y += puff
      z += (z >= 0 ? 1 : -1) * puff * 0.25
    }

    pos.setXYZ(i, x, y, z)

    // перепривязка UV лицевого среза к нормализованным координатам [0..1]
    // чтобы каждый ломтик разного размера точно попадал в зону корочки, жира и мяса
    const normX = (x / (sL + 0.022)) + 0.5
    const normY = (y + 0.011) / (sH + 0.022)
    uv.setXY(i, normX, normY)

    // окраска боковин: поджаристая ромбовидная кожа сверху + румяное мясо снизу
    if (dTop < 0.038) {
      const crisp = clamp01(0.45 + 0.55 * N.noise3(x * 26 + seed, y * 26, z * 26))
      c.copy(skinDark).lerp(skinAmber, crisp)
      // в насечках кожи просвечивает золотистый вытопленный жир
      c.lerp(fatGold, score * 0.62)
      // лёгкое подпаливание по самым верхним гребням от углей
      c.lerp(searedDeep, smooth(0.75, 1.0, crisp) * (1 - score) * 0.35)
    } else {
      const searNoise = clamp01(0.35 + 0.45 * N.noise3(x * 18 + seed, y * 18, z * 18))
      c.copy(seared).lerp(searedDeep, searNoise * 0.65)
    }
    colors[i * 3] = c.r
    colors[i * 3 + 1] = c.g
    colors[i * 3 + 2] = c.b
  }

  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  geo.computeVertexNormals()
  return { geo, sL, sH, sT, topFn }
}

function buildDuck({ N, rand, hi, aniso }, micro) {
  const L = 0.9
  const H = 0.245
  const T = 0.078

  const faceTex = duckFaceTextures(N, hi ? 640 : 384, aniso)
  const skinNormal = buildDuckSkinNormal(N, hi ? 256 : 128, aniso)

  const sideMat = new THREE.MeshPhysicalMaterial({
    vertexColors: true,
    roughness: 0.34,
    clearcoat: 0.72,
    clearcoatRoughness: 0.18,
    normalMap: skinNormal,
    normalScale: new THREE.Vector2(1.1, 1.1),
    specularIntensity: 0.9,
    envMapIntensity: 1.15,
  })

  const specs = getDuckSliceSpecs(5)
  const group = new THREE.Group()
  const meshes = []

  // данные для инстансинга соли и перца прямо поверх срезов
  const saltTransforms = []
  const pepperTransforms = []

  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i]
    const { geo, sL, sH, sT, topFn } = buildDuckSliceGeometry(N, spec, L, H, T)

    // индивидуальный лёгкий сдвиг оттенка мяса для каждого ломтика
    const tint = new THREE.Color().setRGB(spec.tint, spec.tint * 0.985, spec.tint * 0.98)
    const faceMat = new THREE.MeshPhysicalMaterial({
      color: tint,
      map: faceTex.map,
      roughnessMap: faceTex.rough,
      roughness: 1,
      normalMap: faceTex.normal,
      normalScale: new THREE.Vector2(0.95, 0.95),
      clearcoat: 0.3,
      clearcoatRoughness: 0.24,
      sheen: 0.22,
      sheenColor: new THREE.Color(0xd6767a),
      sheenRoughness: 0.55,
      specularIntensity: 0.85,
      envMapIntensity: 1.1,
    })

    const m = new THREE.Mesh(geo, [faceMat, sideMat])
    m.rotation.order = 'YXZ'
    // элегантная «черепица» — естественный наклон, плавная дуга веера
    m.rotation.set(-Math.PI / 2 + 0.35 + (i - 2) * 0.012, spec.yawOffset, spec.rollOffset)
    const xPos = (i - 2) * 0.072 + Math.sin(i * 0.8) * 0.012
    const zPos = -0.29 + i * 0.146
    const baseY = plateSurfaceY(Math.hypot(xPos + 0.18, zPos + 0.08), WELL)
    m.position.set(xPos, baseY + 0.048, zPos)
    m.castShadow = true
    m.receiveShadow = true
    m.name = 'duck-slice'
    m.updateMatrix()

    // кристаллы соли Maldon и дроблёный перец на поверхности среза
    const flakes = 2 + Math.floor(rand() * 3)
    for (let f = 0; f < flakes; f++) {
      const u = (rand() - 0.5) * 1.15
      const maxH = Math.max(0.08, topFn(u) - 0.05)
      _pos.set((u * sL) / 2, 0.045 + rand() * (maxH - 0.045), sT / 2 + 0.015)
      _euler.set(Math.PI / 2 + (rand() - 0.5) * 0.35, rand() * Math.PI * 2, (rand() - 0.5) * 0.35)
      _quat.setFromEuler(_euler)
      const sc = 0.0062 + rand() * 0.0044
      _scale.set(sc * (0.9 + rand() * 0.35), sc * 0.45, sc * (0.9 + rand() * 0.35))
      _mat4.compose(_pos, _quat, _scale)
      _mat4.premultiply(m.matrix)
      saltTransforms.push(_mat4.clone())
    }
    const peppers = 3 + Math.floor(rand() * 2)
    for (let f = 0; f < peppers; f++) {
      const u = (rand() - 0.5) * 1.3
      const maxH = Math.max(0.07, topFn(u) - 0.045)
      _pos.set((u * sL) / 2, 0.04 + rand() * (maxH - 0.04), sT / 2 + 0.014)
      _euler.set(rand() * 3, rand() * 3, rand() * 3)
      _quat.setFromEuler(_euler)
      const sc = 0.0042 + rand() * 0.0025
      _scale.set(sc * 1.2, sc * 0.65, sc)
      _mat4.compose(_pos, _quat, _scale)
      _mat4.premultiply(m.matrix)
      pepperTransforms.push(_mat4.clone())
    }

    group.add(m)
    meshes.push(m)
  }

  // инстансированные кристаллы пирамидальной морской соли Maldon
  const saltGeo = new THREE.CylinderGeometry(0.18, 1.0, 0.62, 4)
  const saltMat = new THREE.MeshPhysicalMaterial({
    color: 0xeae2d4,
    roughness: 0.24,
    clearcoat: 0.55,
    clearcoatRoughness: 0.16,
    specularIntensity: 0.85,
    transparent: true,
    opacity: 0.86,
  })
  const saltInst = new THREE.InstancedMesh(saltGeo, saltMat, saltTransforms.length)
  saltTransforms.forEach((mat, idx) => saltInst.setMatrixAt(idx, mat))
  saltInst.instanceMatrix.needsUpdate = true
  saltInst.computeBoundingSphere()
  saltInst.receiveShadow = true
  group.add(saltInst)

  // инстансированный дроблёный чёрный перец
  const pepperGeo = new THREE.DodecahedronGeometry(1, 0)
  const pepperMat = new THREE.MeshStandardMaterial({ color: 0x1a120d, roughness: 0.82 })
  const pepperInst = new THREE.InstancedMesh(pepperGeo, pepperMat, pepperTransforms.length)
  pepperTransforms.forEach((mat, idx) => pepperInst.setMatrixAt(idx, mat))
  pepperInst.instanceMatrix.needsUpdate = true
  pepperInst.computeBoundingSphere()
  group.add(pepperInst)

  group.position.set(0.2, 0, 0.09)
  group.rotation.y = 0.56
  return { group, meshes, L, H, T }
}

function buildDuckSkinNormal(N, S, aniso) {
  const heights = new Float32Array(S * S)
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = x / S
      const v = y / S
      // пузырчатая хрустящая текстура запечённой кожи
      const blister = N.fbm2(u * 26 + 3, v * 26 - 5, 4) * 0.5 + 0.5
      const pore = smooth(0.62, 0.88, N.noise2(u * 54, v * 54) * 0.5 + 0.5)
      heights[y * S + x] = clamp01(0.5 + (blister - 0.5) * 0.55 - pore * 0.25)
    }
  }
  const tex = heightToNormalTexture(heights, S, S, {
    strength: 2.8,
    aniso,
    wrap: THREE.RepeatWrapping,
  })
  tex.repeat.set(4, 4)
  return tex
}

function duckFaceTextures(N, W, aniso) {
  const Hh = Math.round(W * 0.34)
  const cvC = makeCanvas(W, Hh)
  const cvR = makeCanvas(W, Hh)
  const gC = cvC.getContext('2d')
  const gR = cvR.getContext('2d')
  const iC = gC.createImageData(W, Hh)
  const iR = gR.createImageData(W, Hh)
  const heights = new Float32Array(W * Hh)

  // реалистичная палитра medium-rare утки (деликатный вытопленный жир + сочный рубиновый центр)
  const skinDark = hex(0x3a1608)
  const skinGold = hex(0x884216)
  const fatWarm = hex(0xc79966)
  const fatAmber = hex(0xa46f3d)
  const searCrust = hex(0x4b2417)
  const cookedBand = hex(0x744336)
  const roseOuter = hex(0x832130)
  const rubyHeart = hex(0x982636)
  const deepGarnet = hex(0x5c131f)
  const marbling = hex(0xb05c62)

  const out = [0, 0, 0]
  const tmp = [0, 0, 0]

  const normTop = (u) => duckTopProfile(u, 0.245) / 0.245

  for (let py = 0; py < Hh; py++) {
    const ny = 1 - (py + 0.5) / Hh // 0..1 снизу вверх
    for (let px = 0; px < W; px++) {
      const nx = (px + 0.5) / W // 0..1 слева направо
      const u = (nx - 0.5) * 2
      const topY = normTop(u)

      // расстояния в нормализованной высоте (0..1)
      const dTop = topY - ny
      const dBot = ny
      const dEnd = 1 - Math.abs(u)

      // органически волнистая граница кожи и тонкого вытопленного жира
      const wSkin = N.fbm2(nx * 16 + 1.5, ny * 6, 3)
      const wFat = N.fbm2(nx * 9 + 4.2, ny * 8, 3)
      const skinT = 0.044 + 0.016 * (wSkin * 0.5 + 0.5)
      const fatT = 0.044 + 0.02 * (wFat * 0.5 + 0.5)

      let rough
      let h

      if (dTop < skinT) {
        // тонкая хрустящая карамелизированная кожа
        const blister = clamp01(0.45 + 0.65 * N.fbm2(nx * 46, ny * 26, 3))
        lerpC(skinDark, skinGold, blister, out)
        rough = 0.24 + 0.1 * (1 - blister)
        h = 0.55 + 0.28 * blister
      } else if (dTop < skinT + fatT) {
        // вытопленный подкожный жир — мягко переходит в румяное мясо, без жёсткой белой полосы
        const f = clamp01((dTop - skinT) / fatT)
        const fatTex = clamp01(0.4 + 0.5 * N.fbm2(nx * 28, ny * 18, 2))
        lerpC(fatWarm, fatAmber, fatTex, out)
        // верхняя кромка жира чуть подзолочена от кожи
        lerpC(out, skinGold, (1 - smooth(0, 0.35, f)) * 0.45, out)
        // нижняя кромка жира мягко врастает в прожаренный край мяса
        lerpC(out, cookedBand, smooth(0.55, 1, f) * 0.65, out)
        rough = 0.22 + 0.12 * f
        h = 0.56 - 0.08 * f + 0.06 * fatTex
      } else {
        // глубина внутрь мяса от обжаренного периметра
        const innerTop = dTop - skinT - fatT
        const depth = Math.min(innerTop * 1.0, dBot * 1.15, dEnd * 0.42)
        const edgeWarp = (N.noise2(nx * 14, ny * 14) * 0.5 + 0.5) * 0.032
        const effDepth = depth + edgeWarp

        if (effDepth < 0.045) {
          lerpC(searCrust, cookedBand, clamp01(effDepth / 0.045), out)
        } else {
          lerpC(cookedBand, roseOuter, smooth(0.038, 0.16, effDepth), out)
          lerpC(out, rubyHeart, smooth(0.15, 0.36, effDepth), tmp)
          out[0] = tmp[0]
          out[1] = tmp[1]
          out[2] = tmp[2]
        }

        // многослойные мышечные волокна + естественная мраморность и сочные карманы миоглобина
        const warp = N.fbm2(nx * 5.5, ny * 12, 2) * 0.45
        const bundle = N.fbm2(nx * 12 + warp * 2.2, ny * 46, 3) * 0.5 + 0.5
        const fineFib = N.noise2(nx * 24 + warp * 3, ny * 105) * 0.5 + 0.5
        const pocket = smooth(0.58, 0.92, N.fbm2(nx * 9 + 7, ny * 14 - 3, 2) * 0.5 + 0.5)

        // тёмные сочные участки в глубине мяса
        lerpC(out, deepGarnet, pocket * smooth(0.1, 0.3, effDepth) * 0.48, out)
        // тончайшая соединительная ткань между пучками волокон
        const fascia = smooth(0.84, 0.96, bundle) * smooth(0.08, 0.25, effDepth)
        lerpC(out, marbling, fascia * 0.28, out)

        const shade = 0.88 + 0.16 * bundle - 0.08 * fineFib
        out[0] *= shade
        out[1] *= shade
        out[2] *= shade

        // влажные блики сока в центре, более сухой край у корочки
        const wetness = smooth(0.06, 0.26, effDepth) * (0.45 + 0.55 * pocket)
        rough = 0.52 - 0.34 * wetness + 0.08 * (1 - bundle)
        h = 0.45 + 0.24 * bundle + 0.14 * fineFib - 0.1 * pocket
      }

      const pIdx = py * W + px
      const i = pIdx * 4
      iC.data[i] = Math.min(255, Math.max(0, out[0]))
      iC.data[i + 1] = Math.min(255, Math.max(0, out[1]))
      iC.data[i + 2] = Math.min(255, Math.max(0, out[2]))
      iC.data[i + 3] = 255
      const rv = clamp01(rough) * 255
      iR.data[i] = iR.data[i + 1] = iR.data[i + 2] = rv
      iR.data[i + 3] = 255
      heights[pIdx] = clamp01(h)
    }
  }
  gC.putImageData(iC, 0, 0)
  gR.putImageData(iR, 0, 0)

  const normal = heightToNormalTexture(heights, W, Hh, { strength: 2.6, aniso })

  return {
    map: toTexture(cvC, { srgb: true, aniso }),
    rough: toTexture(cvR, { aniso }),
    normal,
  }
}

// ---------------------------------------------------------------------------
// charred roasted beetroot wedges (knife-cut facets, not candy cubes)
// ---------------------------------------------------------------------------
function beetTextures(N, S, aniso) {
  const cv = makeCanvas(S, S)
  const g = cv.getContext('2d')
  const img = g.createImageData(S, S)
  const heights = new Float32Array(S * S)

  const deepBeet = hex(0x4b0820)
  const richBeet = hex(0x80133a)
  const rubyRing = hex(0xab2454)
  const out = [0, 0, 0]

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = x / S - 0.3
      const dy = y / S - 0.62
      const d = Math.hypot(dx, dy)
      const warp = N.fbm2(x * 0.025, y * 0.025, 2) * 0.55
      const ring = Math.sin(d * 42 + warp * 3.5) * 0.5 + 0.5
      lerpC(deepBeet, richBeet, 0.3 + ring * 0.45, out)
      lerpC(out, rubyRing, smooth(0.84, 1, ring) * 0.3, out)
      const grain = N.fbm2(x * 0.14, y * 0.14, 3)
      const k = 0.88 + 0.14 * (grain * 0.5 + 0.5)
      const pIdx = y * S + x
      const i = pIdx * 4
      img.data[i] = out[0] * k
      img.data[i + 1] = out[1] * k
      img.data[i + 2] = out[2] * k
      img.data[i + 3] = 255
      heights[pIdx] = clamp01(0.5 + 0.18 * (ring - 0.5) + 0.22 * grain)
    }
  }
  g.putImageData(img, 0, 0)
  return {
    map: toTexture(cv, { srgb: true, aniso, wrap: THREE.RepeatWrapping }),
    normal: heightToNormalTexture(heights, S, S, { strength: 2.1, aniso, wrap: THREE.RepeatWrapping }),
  }
}

function buildBeetWedgeGeometry(N, rand, k) {
  const g = new THREE.IcosahedronGeometry(0.088, 2)
  const pos = g.attributes.position
  const colors = new Float32Array(pos.count * 3)
  const v = new THREE.Vector3()
  const baseC = new THREE.Color(0xffffff)
  const charC = new THREE.Color(0x281014)
  const c = new THREE.Color()

  // два-три плоских среза ножом превращают сферу в неровный печёный клин
  const cutA = new THREE.Vector3(0.75, 0.52, 0.35).normalize()
  const cutB = new THREE.Vector3(-0.68, 0.48, -0.42).normalize()
  const cutBottom = new THREE.Vector3(0, -1, 0)
  const sx = 0.85 + rand() * 0.45
  const sy = 0.65 + rand() * 0.32
  const sz = 0.85 + rand() * 0.42

  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i)
    const dA = v.dot(cutA)
    if (dA > 0.03) v.addScaledVector(cutA, -(dA - 0.03) * 0.84)
    const dB = v.dot(cutB)
    if (dB > 0.035) v.addScaledVector(cutB, -(dB - 0.035) * 0.84)
    const dBot = v.dot(cutBottom)
    if (dBot > 0.048) v.addScaledVector(cutBottom, -(dBot - 0.048) * 0.92)

    const ripple = N.noise3(v.x * 18 + k * 7, v.y * 18, v.z * 18) * 0.0085
    v.multiplyScalar(1 + ripple / 0.085)
    v.set(v.x * sx, v.y * sy, v.z * sz)
    pos.setXYZ(i, v.x, v.y, v.z)

    // деликатное подпаливание только по самым острым верхним рёбрам клина из печи
    const ridge = smooth(0.032, 0.08, v.y) * smooth(0.038, 0.1, Math.hypot(v.x, v.z))
    c.copy(baseC).lerp(charC, ridge * 0.44)
    colors[i * 3] = c.r
    colors[i * 3 + 1] = c.g
    colors[i * 3 + 2] = c.b
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  g.computeVertexNormals()
  g.computeBoundingBox()
  // ставим дно клина точно в y = 0
  g.translate(0, -g.boundingBox.min.y, 0)
  return g
}

function buildBeets({ N, rand, hi, aniso }) {
  const tex = beetTextures(N, hi ? 256 : 128, aniso)
  const mat = new THREE.MeshPhysicalMaterial({
    vertexColors: true,
    map: tex.map,
    normalMap: tex.normal,
    normalScale: new THREE.Vector2(0.85, 0.85),
    roughness: 0.36,
    clearcoat: 0.32,
    clearcoatRoughness: 0.28,
    specularIntensity: 0.7,
  })
  const spots = [
    [-0.22, 0.6],
    [0.05, 0.71],
    [-0.45, 0.48],
    [0.68, -0.2],
    [0.74, 0.14],
    [0.54, 0.48],
  ]
  return spots.map(([x, z], k) => {
    const geo = buildBeetWedgeGeometry(N, rand, k)
    const m = new THREE.Mesh(geo, mat)
    const y = plateSurfaceY(Math.hypot(x, z), WELL)
    m.position.set(x, y - 0.002, z)
    m.rotation.set((rand() - 0.5) * 0.14, rand() * Math.PI * 2, (rand() - 0.5) * 0.14)
    m.name = 'beet'
    return m
  })
}

// ---------------------------------------------------------------------------
// caramelized charred red-shallot petals (authentic Michelin plating accent)
// ---------------------------------------------------------------------------
function buildShallots({ N, hi, aniso }) {
  const S = hi ? 128 : 64
  const cv = makeCanvas(S, S)
  const g = cv.getContext('2d')
  const img = g.createImageData(S, S)
  const heights = new Float32Array(S * S)

  const basePale = hex(0xc68b86)
  const midRose = hex(0x7c2d42)
  const charTip = hex(0x210e0a)
  const out = [0, 0, 0]

  for (let y = 0; y < S; y++) {
    const v = 1 - y / S // 0 у основания, 1 у обожжённого края
    for (let x = 0; x < S; x++) {
      const u = x / S
      const vein = Math.sin(u * Math.PI * 18) * 0.5 + 0.5
      lerpC(basePale, midRose, smooth(0.15, 0.72, v), out)
      const charAmt = smooth(0.74, 0.96, v + N.noise2(u * 8, v * 4) * 0.08)
      lerpC(out, charTip, charAmt, out)
      const k = 0.92 + 0.1 * vein
      const pIdx = y * S + x
      const i = pIdx * 4
      img.data[i] = out[0] * k
      img.data[i + 1] = out[1] * k
      img.data[i + 2] = out[2] * k
      img.data[i + 3] = 255
      heights[pIdx] = clamp01(0.5 + 0.18 * (vein - 0.5))
    }
  }
  g.putImageData(img, 0, 0)
  const map = toTexture(cv, { srgb: true, aniso })
  const normal = heightToNormalTexture(heights, S, S, { strength: 1.4, aniso })

  const mat = new THREE.MeshPhysicalMaterial({
    map,
    normalMap: normal,
    normalScale: new THREE.Vector2(0.5, 0.5),
    roughness: 0.34,
    clearcoat: 0.45,
    clearcoatRoughness: 0.25,
    sheen: 0.3,
    sheenColor: new THREE.Color(0xdca0a8),
    side: THREE.DoubleSide,
  })

  // тонкая изогнутая чашечка-лепесток шалота
  const makePetalGeo = (w, h, cup) => {
    const segU = 14
    const segV = 12
    const pos = []
    const uv = []
    const idx = []
    for (let iv = 0; iv <= segV; iv++) {
      const v = iv / segV
      const widthEnv = Math.sin(Math.pow(v, 0.75) * Math.PI)
      for (let iu = 0; iu <= segU; iu++) {
        const u = iu / segU
        const s = u * 2 - 1 // -1..1
        const px = s * w * 0.5 * (0.28 + 0.72 * widthEnv)
        const py = Math.sin(v * Math.PI * 0.88) * h
        const pz = (1 - s * s) * cup * (0.3 + 0.7 * widthEnv) - v * v * cup * 0.45
        pos.push(px, py, pz)
        uv.push(u, v)
      }
    }
    const row = segU + 1
    for (let iv = 0; iv < segV; iv++) {
      for (let iu = 0; iu < segU; iu++) {
        const a = iv * row + iu
        const b = a + row
        idx.push(a, b, a + 1, b, b + 1, a + 1)
      }
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
    geo.setIndex(idx)
    geo.computeVertexNormals()
    return geo
  }

  const placements = [
    { x: -0.34, z: 0.34, ry: 0.9, rx: 0.25, rz: -0.18, w: 0.17, h: 0.125, cup: 0.055 },
    { x: 0.46, z: -0.36, ry: -1.8, rx: 0.32, rz: 0.14, w: 0.16, h: 0.115, cup: 0.05 },
    { x: -0.14, z: -0.48, ry: 2.35, rx: 0.28, rz: -0.12, w: 0.15, h: 0.105, cup: 0.048 },
  ]

  return placements.map((p) => {
    const m = new THREE.Mesh(makePetalGeo(p.w, p.h, p.cup), mat)
    const y = plateSurfaceY(Math.hypot(p.x, p.z), WELL)
    m.position.set(p.x, y + 0.002, p.z)
    m.rotation.set(p.rx, p.ry, p.rz)
    m.name = 'shallot-petal'
    return m
  })
}

// ---------------------------------------------------------------------------
// glossy cherry-wine jus reduction + herb olive oil (NO transmission double pass!)
// ---------------------------------------------------------------------------
function dropGeometry(segments = 32) {
  const pts = [
    [1.02, 0], [1.0, 0.2], [0.95, 0.48], [0.86, 0.74], [0.72, 0.91], [0.46, 0.98], [0.18, 1], [0, 1],
  ].map(([r, y]) => new THREE.Vector2(r, y))
  return new THREE.LatheGeometry(pts, segments)
}

function organicPoolGeometry(N, rx, rz, h = 0.011) {
  const g = dropGeometry(56)
  const pos = g.attributes.position
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    const y = pos.getY(i)
    const z = pos.getZ(i)
    const ang = Math.atan2(z, x)
    const lobe = 1 + 0.16 * N.noise2(Math.cos(ang) * 1.9 + 2, Math.sin(ang) * 1.9 - 1)
    pos.setXYZ(i, x * rx * lobe, y * h, z * rz * lobe)
  }
  g.computeVertexNormals()
  return g
}

function buildSauce({ N, hi }, micro) {
  const ripple = micro.normal.clone()
  ripple.repeat.set(2.2, 2.2)
  const mat = new THREE.MeshPhysicalMaterial({
    color: 0x3b0510,
    roughness: 0.09,
    clearcoat: 0.88,
    clearcoatRoughness: 0.08,
    ior: 1.42,
    specularIntensity: 0.85,
    envMapIntensity: 0.88,
    normalMap: ripple,
    normalScale: new THREE.Vector2(0.16, 0.16),
    sheen: 0.28,
    sheenColor: new THREE.Color(0x8c1228),
    sheenRoughness: 0.35,
  })

  const poolCenter = new THREE.Vector2(0.22, 0.11)
  const pool = new THREE.Mesh(organicPoolGeometry(N, 0.23, 0.4, 0.011), mat)
  const poolY = plateSurfaceY(poolCenter.length(), WELL)
  pool.position.set(poolCenter.x, poolY - 0.001, poolCenter.y)
  pool.rotation.y = 0.56
  pool.name = 'cherry-jus'

  // кулинарные капли соуса (InstancedMesh)
  const dots = [
    [0.39, 0.62, 0.048],
    [0.64, 0.34, 0.035],
    [-0.08, -0.35, 0.042],
    [0.19, -0.44, 0.03],
    [-0.51, 0.21, 0.034],
    [0.82, -0.41, 0.024],
    [-0.28, 0.74, 0.028],
    [0.88, 0.18, 0.022],
    [0.18, 0.56, 0.021],
  ]
  const dotGeo = dropGeometry(hi ? 28 : 20)
  const dotInst = new THREE.InstancedMesh(dotGeo, mat, dots.length)
  dots.forEach(([x, z, r], idx) => {
    const y = plateSurfaceY(Math.hypot(x, z), WELL)
    _pos.set(x, y - 0.001, z)
    _euler.set(0, idx * 1.1, 0)
    _quat.setFromEuler(_euler)
    _scale.set(r, r * 0.38, r * (0.88 + ((idx * 37) % 24) / 100))
    _mat4.compose(_pos, _quat, _scale)
    dotInst.setMatrixAt(idx, _mat4)
  })
  dotInst.instanceMatrix.needsUpdate = true
  dotInst.computeBoundingSphere()

  return { meshes: [pool, dotInst], poolCenter }
}

function buildOil({ hi, rand }, poolCenter) {
  // Без transmission: 1 — избегаем повторного рендера всей сцены на каждом кадре,
  // при этом глянцевый clearcoat + отражения окружения дают сочный блеск травяного масла
  const geo = dropGeometry(hi ? 24 : 16)
  const mat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    roughness: 0.03,
    clearcoat: 1.0,
    clearcoatRoughness: 0.02,
    specularIntensity: 1.0,
    envMapIntensity: 1.4,
    transparent: true,
    opacity: 0.88,
  })

  const count = 24
  const inst = new THREE.InstancedMesh(geo, mat, count)
  const goldOil = new THREE.Color(0xdcb932)
  const herbOil = new THREE.Color(0x769c22)

  for (let i = 0; i < count; i++) {
    let x
    let z
    let r
    if (i < 10) {
      // «разбитое» зелёное масло по краю лужицы вишнёвого соуса (приём шеф-подач)
      const a = rand() * Math.PI * 2
      const rx = 0.25 + rand() * 0.16
      const rz = 0.37 + rand() * 0.16
      const ca = Math.cos(0.56)
      const sa = Math.sin(0.56)
      const lx = Math.cos(a) * rx
      const lz = Math.sin(a) * rz
      x = poolCenter.x + lx * ca - lz * sa
      z = poolCenter.y + lx * sa + lz * ca
      r = 0.015 + rand() * 0.021
    } else {
      const a = rand() * Math.PI * 2
      const d = 0.35 + rand() * 0.56
      x = Math.cos(a) * d
      z = Math.sin(a) * d
      r = 0.014 + rand() * 0.022
    }
    const y = plateSurfaceY(Math.hypot(x, z), WELL)
    _pos.set(x, y + 0.001, z)
    _quat.identity()
    _scale.set(r, r * 0.34, r * (0.9 + rand() * 0.22))
    _mat4.compose(_pos, _quat, _scale)
    inst.setMatrixAt(i, _mat4)

    _color.copy(goldOil).lerp(herbOil, 0.25 + rand() * 0.65)
    inst.setColorAt(i, _color)
  }
  inst.instanceMatrix.needsUpdate = true
  if (inst.instanceColor) inst.instanceColor.needsUpdate = true
  inst.computeBoundingSphere()
  return [inst]
}

// ---------------------------------------------------------------------------
// garnish: toasted hazelnut shards (InstancedMesh) + delicate microgreens
// ---------------------------------------------------------------------------
function crumbGeometry(N, seed) {
  const g = new THREE.IcosahedronGeometry(1, 1)
  const pos = g.attributes.position
  const v = new THREE.Vector3()
  const colors = new Float32Array(pos.count * 3)
  const inner = new THREE.Color(0xdcb278)
  const toasted = new THREE.Color(0x9a6434)
  const skin = new THREE.Color(0x522a14)
  const c = new THREE.Color()

  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i)
    const d = 0.92 + N.noise3(v.x * 1.9 + seed, v.y * 1.9, v.z * 1.9) * 0.34
    v.multiplyScalar(d)
    // чуть более угловатые сколы ореха
    if (v.y < -0.5) v.y = -0.5
    pos.setXYZ(i, v.x, v.y, v.z)
    const nVal = N.noise3(v.x * 1.4 - seed, v.y * 1.4, v.z * 1.4)
    c.copy(inner).lerp(toasted, smooth(-0.2, 0.2, nVal)).lerp(skin, smooth(0.18, 0.45, nVal))
    colors[i * 3] = c.r
    colors[i * 3 + 1] = c.g
    colors[i * 3 + 2] = c.b
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  g.computeVertexNormals()
  return g
}

function leafTextures(N, S, palette, aniso) {
  const cv = makeCanvas(S, S)
  const g = cv.getContext('2d')
  const img = g.createImageData(S, S)
  const heights = new Float32Array(S * S)
  const [edgeC, midC, ribC] = palette.map(hex)
  const out = [0, 0, 0]

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = (x / S) * 2 - 1
      const v = 1 - y / S
      const edge = smooth(0.35, 1, Math.abs(u))
      lerpC(midC, edgeC, edge, out)
      const rib = Math.exp(-((u / 0.055) ** 2)) * smooth(0, 0.08, v) * (1 - smooth(0.82, 1, v))
      lerpC(out, ribC, rib * 0.78, out)
      const vq = (((Math.abs(u) * 0.95 - (v - 0.12) * 0.78) % 0.19) + 0.19) % 0.19 - 0.095
      const veins = Math.exp(-((vq / 0.017) ** 2)) * (1 - edge * 0.85)
      lerpC(out, ribC, veins * 0.34, out)
      const k = 0.9 + 0.1 * N.noise2(x * 0.2, y * 0.2)
      const pIdx = y * S + x
      const i = pIdx * 4
      img.data[i] = out[0] * k
      img.data[i + 1] = out[1] * k
      img.data[i + 2] = out[2] * k
      img.data[i + 3] = 255
      heights[pIdx] = clamp01(0.5 + rib * 0.3 + veins * 0.16)
    }
  }
  g.putImageData(img, 0, 0)
  return {
    map: toTexture(cv, { srgb: true, aniso }),
    normal: heightToNormalTexture(heights, S, S, { strength: 1.8, aniso }),
  }
}

function leafGeometry(len, wid, curl = 0.28) {
  const s = new THREE.Shape()
  s.moveTo(0, 0)
  s.bezierCurveTo(wid * 0.95, len * 0.12, wid * 0.82, len * 0.86, 0, len)
  s.bezierCurveTo(-wid * 0.82, len * 0.86, -wid * 0.95, len * 0.12, 0, 0)
  const g = new THREE.ShapeGeometry(s, 10)
  const pos = g.attributes.position
  const uv = g.attributes.uv
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    const y = pos.getY(i)
    const t = y / len
    // изящный естественный прогиб листа (лодочка + загиб кончика вниз)
    const cup = (x / wid) ** 2 * wid * 0.34
    const arch = Math.sin(t * Math.PI) * len * 0.16 - t * t * len * curl
    pos.setZ(i, cup + arch)
    uv.setXY(i, x / (2 * wid) + 0.5, t)
  }
  g.computeVertexNormals()
  return g
}

function buildSprig(rand, mats, leafGeos) {
  const g = new THREE.Group()
  const hgt = 0.032 + rand() * 0.042
  const bendX = (rand() - 0.5) * 0.048
  const bendZ = (rand() - 0.5) * 0.048
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(bendX * 0.45, hgt * 0.55, bendZ * 0.45),
    new THREE.Vector3(bendX, hgt, bendZ),
  ])
  const stem = new THREE.Mesh(new THREE.TubeGeometry(curve, 8, 0.0021, 5, false), mats.stem)
  g.add(stem)

  const tip = curve.getPoint(1)
  const leafCount = 2 + (rand() > 0.35 ? 1 : 0)
  const baseAng = rand() * Math.PI * 2
  for (let i = 0; i < leafCount; i++) {
    const pivot = new THREE.Group()
    const attachT = i === 2 ? 0.68 : 1.0
    pivot.position.copy(curve.getPoint(attachT))
    pivot.rotation.y = baseAng + (i * Math.PI * 2) / leafCount + (rand() - 0.5) * 0.35
    const geo = leafGeos[i % leafGeos.length]
    const leaf = new THREE.Mesh(geo, mats.leaf)
    leaf.rotation.x = -1.02 - rand() * 0.36
    leaf.rotation.z = (rand() - 0.5) * 0.25
    leaf.scale.setScalar((i === 2 ? 0.65 : 0.78) + rand() * 0.32)
    pivot.add(leaf)
    g.add(pivot)
  }
  return g
}

function buildGarnish({ N, rand, hi, aniso }, surfaces, puree) {
  const out = []

  // дроблёный обжаренный фундук (InstancedMesh по 2 формам)
  const crumbMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.68,
    metalness: 0.02,
  })
  const crumbGeos = [crumbGeometry(N, 0), crumbGeometry(N, 4.7)]
  const buckets = [[], []]

  const recordCrumb = (x, z) => {
    const hit = dropOnto(surfaces, x, z)
    if (!hit) return
    const s = 0.013 + rand() * 0.015
    _pos.copy(hit.point).addScaledVector(hit.normal, s * 0.38)
    _euler.set(rand() * 3, rand() * 3, rand() * 3)
    _quat.setFromEuler(_euler)
    _scale.set(s * (0.85 + rand() * 0.55), s * (0.55 + rand() * 0.3), s * (0.85 + rand() * 0.55))
    _mat4.compose(_pos, _quat, _scale)
    buckets[rand() > 0.5 ? 1 : 0].push(_mat4.clone())
  }

  for (let i = 0; i < 20; i++) {
    const p = puree.curve.getPointAt(0.05 + rand() * 0.66)
    recordCrumb(p.x + (rand() - 0.5) * 0.16, p.z + (rand() - 0.5) * 0.16)
  }
  for (let i = 0; i < 8; i++) {
    const a = rand() * Math.PI * 2
    const d = 0.44 + rand() * 0.42
    recordCrumb(Math.cos(a) * d, Math.sin(a) * d)
  }

  buckets.forEach((mats, idx) => {
    if (!mats.length) return
    const inst = new THREE.InstancedMesh(crumbGeos[idx], crumbMat, mats.length)
    mats.forEach((m, i) => inst.setMatrixAt(i, m))
    inst.instanceMatrix.needsUpdate = true
    inst.computeBoundingSphere()
    inst.userData.castShadow = true
    out.push(inst)
  })

  // тонкая микрозелень: щавель с красными прожилками, зелёный кресс и красный амарант
  const S = hi ? 128 : 64
  const sorrelTex = leafTextures(N, S, [0x305818, 0x55842a, 0x9e3044], aniso)
  const cressTex = leafTextures(N, S, [0x39621c, 0x62902e, 0xa8c668], aniso)
  const amaranthTex = leafTextures(N, S, [0x420b20, 0x721738, 0xb04868], aniso)

  const makeHerbMat = (tex, stemColor, sheenColor) => ({
    leaf: new THREE.MeshPhysicalMaterial({
      map: tex.map,
      normalMap: tex.normal,
      normalScale: new THREE.Vector2(0.55, 0.55),
      roughness: 0.42,
      sheen: 0.55,
      sheenColor: new THREE.Color(sheenColor),
      sheenRoughness: 0.35,
      side: THREE.DoubleSide,
    }),
    stem: new THREE.MeshStandardMaterial({ color: stemColor, roughness: 0.52 }),
  })

  const sorrel = makeHerbMat(sorrelTex, 0x9aa86a, 0xcbe898)
  const cress = makeHerbMat(cressTex, 0xb9cc84, 0xd8f0a4)
  const amaranth = makeHerbMat(amaranthTex, 0xb85e78, 0xe896b6)

  const leafGeos = [
    leafGeometry(0.072, 0.034, 0.25),
    leafGeometry(0.058, 0.038, 0.32),
  ]

  const spots = [
    { x: 0.14, z: 0.02, mats: sorrel, n: 3 },
    { x: 0.34, z: 0.22, mats: amaranth, n: 3 },
    { x: -0.6, z: 0.12, mats: cress, n: 3 },
    { x: -0.32, z: -0.54, mats: amaranth, n: 2 },
    { x: 0.08, z: -0.64, mats: sorrel, n: 2 },
    { x: -0.08, z: 0.52, mats: cress, n: 2 },
  ]

  spots.forEach(({ x, z, mats, n }) => {
    for (let i = 0; i < n; i++) {
      const hit = dropOnto(surfaces, x + (rand() - 0.5) * 0.08, z + (rand() - 0.5) * 0.08)
      if (!hit) continue
      const s = buildSprig(rand, mats, leafGeos)
      s.position.copy(hit.point)
      s.rotation.set((rand() - 0.5) * 0.9, rand() * Math.PI * 2, (rand() - 0.5) * 0.9)
      out.push(s)
    }
  })

  return out
}
