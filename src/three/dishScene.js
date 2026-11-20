import * as THREE from 'three'
import dishModel from 'virtual:dish-model'
import { buildProceduralDish } from './proceduralDish.js'
import { computeCameraRig, computeModelNormalization } from './framing.js'
import { mulberry32 } from './noise.js'

const isSoftwareGl = (() => {
  try {
    const gl = document.createElement('canvas').getContext('webgl2')
    if (!gl) return true
    const ext = gl.getExtension('WEBGL_debug_renderer_info')
    const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER
    const gpu = String(gl.getParameter(param))
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu)
  } catch {
    return false
  }
})()

/**
 * Интерактивная 3D-сцена блюда в герое сайта.
 *
 * Если в /public/models/restaurant-dish.glb лежит модель — она загружается сразу,
 * масштабируется под размер сцены и кадрируется с учётом высоты.
 * Если файла нет или он повреждён — мягко показывается процедурное блюдо без ошибок в консоли.
 */
export function createDishScene(container, { reducedMotion = false, onStatus = () => {} } = {}) {
  const isSmall = window.matchMedia('(max-width: 760px)').matches

  // ---------- renderer ----------
  const renderer = new THREE.WebGLRenderer({
    antialias: !isSoftwareGl,
    alpha: true,
    powerPreference: 'high-performance',
  })
  renderer.setPixelRatio(
    isSoftwareGl ? 1 : Math.min(window.devicePixelRatio || 1, isSmall ? 1.5 : 2),
  )
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.02
  renderer.shadowMap.enabled = !isSoftwareGl
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  renderer.domElement.className = 'dish-canvas'
  renderer.domElement.setAttribute('aria-hidden', 'true')
  renderer.domElement.setAttribute('data-testid', 'dish-canvas')
  container.appendChild(renderer.domElement)

  const scene = new THREE.Scene()
  const pmrem = new THREE.PMREMGenerator(renderer)
  const envScene = buildRestaurantEnv()
  const envTex = pmrem.fromScene(envScene, 0.02).texture
  disposeObject(envScene)
  scene.environment = envTex
  scene.environmentIntensity = 1.48

  const camera = new THREE.PerspectiveCamera(24, 1, 0.1, 50)
  const target = new THREE.Vector3(0, 0.5, 0)

  // ---------- studio & restaurant lighting ----------
  scene.add(new THREE.HemisphereLight(0xffe5c4, 0x2a180d, 0.38))

  const fill = new THREE.DirectionalLight(0xffcf9e, 0.58)
  fill.position.set(-2.8, 3.2, 3.8)
  scene.add(fill)

  const key = new THREE.DirectionalLight(0xffe4c6, 2.05)
  key.position.set(2.2, 6.0, 2.6)
  key.castShadow = !isSoftwareGl
  key.shadow.mapSize.set(isSmall ? 1024 : 2048, isSmall ? 1024 : 2048)
  key.shadow.camera.left = -2.8
  key.shadow.camera.right = 2.8
  key.shadow.camera.top = 2.8
  key.shadow.camera.bottom = -2.8
  key.shadow.camera.near = 1
  key.shadow.camera.far = 14
  key.shadow.bias = -0.0005
  key.shadow.normalBias = 0.02
  scene.add(key)

  const rim = new THREE.DirectionalLight(0xcbd694, 1.85)
  rim.position.set(-3.8, 2.8, -3.4)
  scene.add(rim)

  const ember = new THREE.PointLight(0xff5e22, 3.8, 8.5, 2)
  ember.position.set(2.3, 0.65, 1.5)
  scene.add(ember)

  // ---------- ground: shadow + soft contact ----------
  const shadowGround = new THREE.Mesh(
    new THREE.PlaneGeometry(14, 14),
    new THREE.ShadowMaterial({ opacity: 0.48 }),
  )
  shadowGround.rotation.x = -Math.PI / 2
  shadowGround.receiveShadow = true
  scene.add(shadowGround)

  const contact = new THREE.Mesh(
    new THREE.PlaneGeometry(4.4, 4.4),
    new THREE.MeshBasicMaterial({
      map: radialTexture('rgba(0,0,0,0.72)', 'rgba(0,0,0,0)'),
      transparent: true,
      depthWrite: false,
    }),
  )
  contact.rotation.x = -Math.PI / 2
  contact.position.y = 0.002
  scene.add(contact)

  // ---------- dish hierarchy ----------
  const root = new THREE.Group() // наклон от курсора и вход
  const spin = new THREE.Group() // медленное вращение и ручной поворот
  root.add(spin)
  scene.add(root)

  let dish = null
  const modelMetrics = { radius: 1.55, height: 1.95 }

  // ---------- embers ----------
  const embers = reducedMotion ? null : buildEmbers(isSmall ? 18 : 32)
  if (embers) scene.add(embers.points)

  // ---------- sizing ----------
  function fit() {
    const w = Math.max(1, container.clientWidth)
    const h = Math.max(1, container.clientHeight)
    renderer.setSize(w, h, false)
    camera.aspect = w / h

    const rig = computeCameraRig({
      aspect: camera.aspect,
      fovDeg: camera.fov,
      modelRadius: modelMetrics.radius,
      modelHeight: modelMetrics.height,
      isSmall,
    })

    target.set(0, rig.targetY, 0)
    camera.position.set(0, rig.cameraY, rig.cameraZ)
    camera.lookAt(target)
    camera.updateProjectionMatrix()
    if (reducedMotion && dish) render()
  }
  const ro = new ResizeObserver(fit)
  ro.observe(container)
  fit()

  // ---------- interaction ----------
  const tilt = { x: 0, z: 0, tx: 0, tz: 0 }
  const spinVel = reducedMotion ? 0 : 0.13 // рад/с
  let dragVel = 0
  let dragging = false
  let lastX = 0

  function onPointerMove(e) {
    if (e.pointerType === 'mouse') {
      const nx = (e.clientX / window.innerWidth) * 2 - 1
      const ny = (e.clientY / window.innerHeight) * 2 - 1
      tilt.tx = ny * 0.14
      tilt.tz = -nx * 0.09
    }
    if (dragging) {
      const dx = e.clientX - lastX
      lastX = e.clientX
      dragVel = dx * 0.012
      spin.rotation.y += dx * 0.008
    }
    if (reducedMotion && dish) requestRender()
  }
  function onPointerDown(e) {
    dragging = true
    lastX = e.clientX
  }
  function onPointerUp() {
    dragging = false
  }
  window.addEventListener('pointermove', onPointerMove, { passive: true })
  renderer.domElement.addEventListener('pointerdown', onPointerDown)
  window.addEventListener('pointerup', onPointerUp)
  window.addEventListener('pointercancel', onPointerUp)

  // ---------- loop ----------
  const timer = new THREE.Timer()
  let raf = 0
  let timeoutId = 0
  let visible = true
  let disposed = false
  let intro = reducedMotion ? 1 : 0

  function render() {
    renderer.render(scene, camera)
  }

  function afterDraw(cb) {
    const gl = renderer.getContext()
    if (gl && typeof gl.fenceSync === 'function') {
      const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)
      gl.flush()
      const poll = () => {
        if (disposed) {
          if (sync) gl.deleteSync(sync)
          return
        }
        const state = sync && gl.getSyncParameter(sync, gl.SYNC_STATUS)
        if (state === gl.UNSIGNALED) {
          timeoutId = window.setTimeout(poll, 5)
        } else {
          if (sync) gl.deleteSync(sync)
          timeoutId = window.setTimeout(cb, 80)
        }
      }
      timeoutId = window.setTimeout(poll, 5)
      return
    }
    timeoutId = window.setTimeout(cb, 80)
  }

  let pendingRender = false
  function requestRender() {
    if (pendingRender) return
    pendingRender = true
    raf = requestAnimationFrame(() => {
      pendingRender = false
      if (disposed) return
      tilt.x = tilt.tx
      tilt.z = tilt.tz
      root.rotation.x = tilt.x
      root.rotation.z = tilt.z
      render()
    })
  }

  function frame(now) {
    raf = 0
    timeoutId = 0
    if (disposed || !visible) return
    timer.update(now)
    const dt = Math.min(timer.getDelta(), 0.05)
    const t = timer.getElapsed()

    if (intro < 1) {
      intro = Math.min(1, intro + dt / 1.3)
      const e = 1 - Math.pow(1 - intro, 3)
      root.position.y = (isSmall ? 0 : 0.16) + (1 - e) * -0.28
      root.scale.setScalar(0.92 + 0.08 * e)
    } else {
      root.position.y = isSmall ? 0 : 0.16
    }

    tilt.x += (tilt.tx - tilt.x) * Math.min(1, dt * 3.2)
    tilt.z += (tilt.tz - tilt.z) * Math.min(1, dt * 3.2)
    root.rotation.x = tilt.x
    root.rotation.z = tilt.z

    if (!dragging) {
      dragVel *= Math.pow(0.04, dt)
      spin.rotation.y += (spinVel + dragVel) * dt
    }

    ember.intensity = 3.4 + Math.sin(t * 2.3) * 0.4 + Math.sin(t * 5.7) * 0.22
    if (embers) embers.update(dt)

    render()
    if (isSoftwareGl) {
      afterDraw(() => frame(performance.now()))
    } else {
      raf = requestAnimationFrame(frame)
    }
  }

  function start() {
    if (!dish || disposed) return
    if (reducedMotion) {
      root.position.y = 0
      root.scale.setScalar(1)
      render()
      return
    }
    if (!raf && !timeoutId) {
      timer.update()
      if (isSoftwareGl) {
        frame(performance.now())
      } else {
        raf = requestAnimationFrame(frame)
      }
    }
  }

  const io = new IntersectionObserver(
    ([entry]) => {
      visible = entry.isIntersecting && !document.hidden
      if (visible) start()
    },
    { threshold: 0.01 },
  )
  io.observe(container)
  const onVisibility = () => {
    visible = !document.hidden
    if (visible) start()
  }
  document.addEventListener('visibilitychange', onVisibility)

  function mountDish(nextDish, metrics, source, initialYaw = 0) {
    if (disposed) {
      disposeObject(nextDish)
      return
    }
    if (dish) {
      spin.remove(dish)
      disposeObject(dish)
    }
    dish = nextDish
    modelMetrics.radius = metrics.radius
    modelMetrics.height = metrics.height
    spin.rotation.y = initialYaw
    spin.add(dish)
    fit()
    if (!isSoftwareGl) {
      renderer.compile(scene, camera)
    }
    start()
    onStatus({ ready: true, source })
  }

  function mountProceduralFallback() {
    const proc = buildProceduralDish({
      quality: isSmall ? 'medium' : 'high',
      anisotropy: Math.min(8, renderer.capabilities.getMaxAnisotropy()),
    })
    mountDish(proc, { radius: 1.65, height: 0.55 }, 'procedural', 0)
  }

  // ---------- load model or fallback ----------
  if (dishModel.available) {
    loadUserModel(renderer)
      .then((loaded) => {
        if (disposed) return
        if (!loaded) {
          mountProceduralFallback()
          return
        }
        mountDish(
          loaded.model,
          { radius: loaded.radius, height: loaded.height },
          'model',
          loaded.initialYaw,
        )
      })
      .catch((err) => {
        console.info('[Ember & Olive] Модель блюда не загружена, показана заглушка:', err?.message || err)
        mountProceduralFallback()
      })
  } else {
    mountProceduralFallback()
  }

  // ---------- cleanup ----------
  return function dispose() {
    disposed = true
    if (raf) cancelAnimationFrame(raf)
    if (timeoutId) clearTimeout(timeoutId)
    ro.disconnect()
    io.disconnect()
    document.removeEventListener('visibilitychange', onVisibility)
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerup', onPointerUp)
    window.removeEventListener('pointercancel', onPointerUp)
    renderer.domElement.removeEventListener('pointerdown', onPointerDown)
    disposeObject(scene)
    envTex.dispose()
    pmrem.dispose()
    renderer.dispose()
    renderer.domElement.remove()
  }
}

// =====================================================================
// Загрузка 3D-модели (.glb)
// =====================================================================
async function loadUserModel(renderer) {
  if (!dishModel.available) return null
  const res = await fetch(dishModel.url, { cache: 'default' })
  if (!res.ok) return null
  const buf = await res.arrayBuffer()
  if (buf.byteLength < 12) return null
  const magic = String.fromCharCode(...new Uint8Array(buf, 0, 4))
  if (magic !== 'glTF') return null

  const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js')
  const loader = new GLTFLoader()

  const gltf = await loader.parseAsync(buf, '/models/')
  const model = gltf.scene

  // Убираем встроенную камеру из сцены модели, если есть
  const toRemove = []
  model.traverse((o) => {
    if (o.isCamera) toRemove.push(o)
  })
  toRemove.forEach((c) => c.parent?.remove(c))

  model.updateMatrixWorld(true)
  const rawBox = new THREE.Box3().setFromObject(model)
  const norm = computeModelNormalization(rawBox, { targetSpan: 3.3, maxHeight: 2.35 })

  model.scale.setScalar(norm.scale)
  model.position.set(norm.offsetX, norm.offsetY, norm.offsetZ)

  const maxAniso = isSoftwareGl ? 1 : Math.min(8, renderer.capabilities.getMaxAnisotropy())

  model.traverse((o) => {
    if (!o.isMesh) return
    const mats = Array.isArray(o.material) ? o.material : [o.material]
    let isGlass = false

    mats.forEach((mat) => {
      if (!mat) return
      const name = (mat.name || '').toLowerCase()
      const hasTransmission = typeof mat.transmission === 'number' && mat.transmission > 0
      if (hasTransmission || name.includes('glass')) {
        isGlass = true
      }

      if (mat.map) mat.map.anisotropy = maxAniso
      if (mat.normalMap) mat.normalMap.anisotropy = maxAniso
      if (mat.roughnessMap) mat.roughnessMap.anisotropy = maxAniso

      if (name.includes('gold')) {
        mat.envMapIntensity = 2.2
        mat.roughness = Math.min(mat.roughness ?? 0.35, 0.32)
      } else if (name.includes('olive')) {
        mat.envMapIntensity = 1.25
        if (typeof mat.roughness === 'number') {
          mat.roughness = Math.min(mat.roughness, 0.28)
        }
      } else if (isGlass) {
        mat.envMapIntensity = 2.1
      }

      // На программном WebGL заменяем многопроходную трансмиссию
      // на глубокое дымчато-иридесцентное стекло с чистыми бликами.
      if (isSoftwareGl && hasTransmission) {
        mat.transmission = 0
        mat.transparent = true
        if (name.includes('dish')) {
          mat.color.setHex(0x2d2213)
          mat.opacity = 0.16
          mat.roughness = 0.05
          mat.envMapIntensity = 2.3
        } else {
          mat.color.setHex(0x13221a)
          mat.opacity = 0.26
          mat.roughness = 0.06
          mat.clearcoat = 1.0
          mat.clearcoatRoughness = 0.04
          mat.iridescence = 1.0
          mat.iridescenceIOR = 1.48
          mat.envMapIntensity = 2.8
        }
        mat.depthWrite = false
        mat.needsUpdate = true
      }
    })

    // Стеклянный клош не должен отбрасывать сплошную чёрную тень на оливки
    o.castShadow = !isSoftwareGl && !isGlass
    o.receiveShadow = !isSoftwareGl
    if (isGlass) {
      o.renderOrder = o.name.toLowerCase().includes('cover') ? 3 : 2
    }
  })

  return {
    model,
    radius: norm.radius,
    height: norm.normalizedHeight,
    // Поворачиваем открытой стороной клоша к зрителю, чтобы сразу видеть оливки
    initialYaw: -1.45,
  }
}

function buildEmbers(count) {
  const geo = new THREE.BufferGeometry()
  const positions = new Float32Array(count * 3)
  const speeds = new Float32Array(count)
  const phases = new Float32Array(count)
  const rand = mulberry32(11)
  const reset = (i, initial) => {
    const a = rand() * Math.PI * 2
    const d = 1.2 + rand() * 1.4
    positions[i * 3] = Math.cos(a) * d
    positions[i * 3 + 1] = initial ? rand() * 2.4 : 0.05
    positions[i * 3 + 2] = Math.sin(a) * d - 0.6
    speeds[i] = 0.12 + rand() * 0.22
    phases[i] = rand() * 10
  }
  for (let i = 0; i < count; i++) reset(i, true)
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  const mat = new THREE.PointsMaterial({
    size: 0.045,
    map: radialTexture('rgba(255,170,90,1)', 'rgba(255,80,20,0)'),
    color: 0xff8a4a,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    sizeAttenuation: true,
  })
  const points = new THREE.Points(geo, mat)
  let time = 0
  return {
    points,
    update(dt) {
      time += dt
      for (let i = 0; i < count; i++) {
        positions[i * 3 + 1] += speeds[i] * dt
        positions[i * 3] += Math.sin(time * 0.8 + phases[i]) * 0.0015
        if (positions[i * 3 + 1] > 2.6) reset(i, false)
      }
      geo.attributes.position.needsUpdate = true
    },
  }
}

// =====================================================================
// helpers
// =====================================================================

/** Окружение для отражений: тёплый золотой купол, студийные софтбоксы, оливковый контровой и огни очага. */
function buildRestaurantEnv() {
  const env = new THREE.Scene()
  const room = new THREE.Mesh(
    new THREE.BoxGeometry(24, 12, 24),
    new THREE.MeshBasicMaterial({ color: 0x3b2718, side: THREE.BackSide }),
  )
  room.position.y = 5
  env.add(room)

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(24, 24),
    new THREE.MeshBasicMaterial({ color: 0x523620 }),
  )
  floor.rotation.x = -Math.PI / 2
  floor.position.y = -0.8
  env.add(floor)

  const origin = new THREE.Vector3(0, 0.5, 0)
  const panel = (w, h, color, intensity, x, y, z) => {
    const mat = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide })
    mat.color.multiplyScalar(intensity)
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat)
    m.position.set(x, y, z)
    m.lookAt(origin)
    env.add(m)
  }
  panel(12, 7.5, 0xffeed8, 6.2, 4.5, 9, 5.5) // широкий верхний софтбокс для сусального золота
  panel(12, 5.5, 0xfff3e2, 3.6, -10, 5.0, 2.5) // боковой тёплый свет
  panel(8, 4.5, 0xd9e4a8, 3.8, -5.5, 4.5, -8.5) // оливковый контровой для стекла
  panel(7, 3.5, 0xffa65c, 3.2, 8.5, 2.8, -2.5) // тёплый янтарный отсвет очага
  panel(11, 5.5, 0xfff6ea, 3.4, 0, 10.5, -1) // верхняя подсветка купола клоша
  panel(9, 4.0, 0xf2cf94, 2.6, 2, 3.2, 9.5) // фронтальное золотистое отражение

  const bulbGeo = new THREE.SphereGeometry(0.4, 16, 12)
  ;[
    [-3, 8, -2],
    [2.5, 8.5, -4],
    [0.5, 7.8, 3.8],
  ].forEach(([x, y, z]) => {
    const mat = new THREE.MeshBasicMaterial({ color: 0xffc080 })
    mat.color.multiplyScalar(32)
    const b = new THREE.Mesh(bulbGeo, mat)
    b.position.set(x, y, z)
    env.add(b)
  })
  return env
}

function radialTexture(inner, outer) {
  const s = 128
  const cv = document.createElement('canvas')
  cv.width = cv.height = s
  const ctx = cv.getContext('2d')
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2)
  g.addColorStop(0, inner)
  g.addColorStop(1, outer)
  ctx.fillStyle = g
  ctx.fillRect(0, 0, s, s)
  const tex = new THREE.CanvasTexture(cv)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

function disposeObject(obj) {
  obj.traverse((o) => {
    if (o.geometry) o.geometry.dispose()
    if (o.material) {
      const mats = Array.isArray(o.material) ? o.material : [o.material]
      mats.forEach((m) => {
        Object.values(m).forEach((v) => {
          if (v && v.isTexture) v.dispose()
        })
        m.dispose()
      })
    }
  })
}
