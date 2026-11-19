import * as THREE from 'three'
import dishModel from 'virtual:dish-model'
import { buildProceduralDish } from './proceduralDish.js'
import { mulberry32 } from './noise.js'

/**
 * Интерактивная 3D-сцена «блюдо на керамической тарелке».
 *
 * Если в /public/models/restaurant-dish.glb лежит модель — она загружается,
 * масштабируется под размер сцены и заменяет процедурное блюдо.
 * Если файла нет или он повреждён — остаётся процедурная версия, без ошибок в консоли.
 */
export function createDishScene(container, { reducedMotion = false, onStatus = () => {} } = {}) {
  const isSmall = window.matchMedia('(max-width: 760px)').matches

  // ---------- renderer ----------
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    powerPreference: 'high-performance',
  })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, isSmall ? 1.5 : 2))
  renderer.outputColorSpace = THREE.SRGBColorSpace
  // Neutral бережнее к цветам еды, чем ACES: не выжигает оранжевый и розовый
  renderer.toneMapping = THREE.NeutralToneMapping
  renderer.toneMappingExposure = 1.0
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFShadowMap
  renderer.domElement.className = 'dish-canvas'
  renderer.domElement.setAttribute('aria-hidden', 'true')
  container.appendChild(renderer.domElement)

  const scene = new THREE.Scene()
  const pmrem = new THREE.PMREMGenerator(renderer)
  const envScene = buildRestaurantEnv()
  const envTex = pmrem.fromScene(envScene, 0.02).texture
  disposeObject(envScene)
  scene.environment = envTex
  scene.environmentIntensity = 0.85

  const camera = new THREE.PerspectiveCamera(24, 1, 0.1, 50)
  const target = new THREE.Vector3(0, 0.1, 0)

  // ---------- light ----------
  scene.add(new THREE.HemisphereLight(0xffe2c2, 0x3a2414, 0.25))

  // мягкий тёплый заполняющий свет без теней — тени на глазури не уходят в серый
  const fill = new THREE.DirectionalLight(0xffc89a, 0.45)
  fill.position.set(-2.5, 3, 3.5)
  scene.add(fill)

  const key = new THREE.DirectionalLight(0xffe4c8, 2.6)
  key.position.set(1.6, 6.2, 1.8)
  key.castShadow = true
  key.shadow.mapSize.set(isSmall ? 1024 : 2048, isSmall ? 1024 : 2048)
  key.shadow.camera.left = -2.6
  key.shadow.camera.right = 2.6
  key.shadow.camera.top = 2.6
  key.shadow.camera.bottom = -2.6
  key.shadow.camera.near = 1
  key.shadow.camera.far = 14
  key.shadow.bias = -0.0004
  key.shadow.normalBias = 0.02
  key.shadow.radius = 8
  key.shadow.blurSamples = 16
  scene.add(key)

  const rim = new THREE.DirectionalLight(0xc8cf98, 1.3)
  rim.position.set(-3.6, 2.4, -3.2)
  scene.add(rim)

  const ember = new THREE.PointLight(0xff5a1f, 3.5, 7, 2)
  ember.position.set(2.1, 0.5, 1.4)
  scene.add(ember)

  // ---------- ground: shadow + soft contact ----------
  const shadowGround = new THREE.Mesh(
    new THREE.PlaneGeometry(14, 14),
    new THREE.ShadowMaterial({ opacity: 0.55 }),
  )
  shadowGround.rotation.x = -Math.PI / 2
  shadowGround.receiveShadow = true
  scene.add(shadowGround)

  const contact = new THREE.Mesh(
    new THREE.PlaneGeometry(4.6, 4.6),
    new THREE.MeshBasicMaterial({
      map: radialTexture('rgba(0,0,0,0.75)', 'rgba(0,0,0,0)'),
      transparent: true,
      depthWrite: false,
    }),
  )
  contact.rotation.x = -Math.PI / 2
  contact.position.y = 0.002
  scene.add(contact)

  // ---------- dish hierarchy ----------
  const root = new THREE.Group() // наклон от курсора
  const spin = new THREE.Group() // медленное вращение
  root.add(spin)
  scene.add(root)

  let dish = buildProceduralDish({
    quality: isSmall ? 'medium' : 'high',
    anisotropy: Math.min(8, renderer.capabilities.getMaxAnisotropy()),
  })
  spin.add(dish)

  // ---------- embers ----------
  const embers = reducedMotion ? null : buildEmbers(isSmall ? 18 : 34)
  if (embers) scene.add(embers.points)

  // ---------- sizing ----------
  function fit() {
    const w = Math.max(1, container.clientWidth)
    const h = Math.max(1, container.clientHeight)
    renderer.setSize(w, h, false)
    camera.aspect = w / h
    const t = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))
    const dist = Math.max(1.8 / (t * camera.aspect), 1.3 / t)
    const elev = THREE.MathUtils.degToRad(isSmall ? 34 : 30)
    camera.position.set(0, Math.sin(elev) * dist + target.y, Math.cos(elev) * dist)
    camera.lookAt(target)
    camera.updateProjectionMatrix()
    if (reducedMotion) render()
  }
  const ro = new ResizeObserver(fit)
  ro.observe(container)
  fit()

  // ---------- interaction ----------
  const tilt = { x: 0, z: 0, tx: 0, tz: 0 }
  const spinVel = reducedMotion ? 0 : 0.14 // рад/с
  let dragVel = 0
  let dragging = false
  let lastX = 0

  function onPointerMove(e) {
    if (e.pointerType === 'mouse') {
      const nx = (e.clientX / window.innerWidth) * 2 - 1
      const ny = (e.clientY / window.innerHeight) * 2 - 1
      tilt.tx = ny * 0.16
      tilt.tz = -nx * 0.1
    }
    if (dragging) {
      const dx = e.clientX - lastX
      lastX = e.clientX
      dragVel = dx * 0.012
      spin.rotation.y += dx * 0.008
    }
    if (reducedMotion) requestRender()
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
  let visible = true
  let disposed = false
  let intro = reducedMotion ? 1 : 0

  function render() {
    renderer.render(scene, camera)
  }
  let pendingRender = false
  function requestRender() {
    if (pendingRender) return
    pendingRender = true
    requestAnimationFrame(() => {
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
    if (disposed || !visible) return
    timer.update(now)
    const dt = Math.min(timer.getDelta(), 0.05)
    const t = timer.getElapsed()

    if (intro < 1) {
      intro = Math.min(1, intro + dt / 1.6)
      const e = 1 - Math.pow(1 - intro, 3)
      root.position.y = (1 - e) * -0.35
      root.scale.setScalar(0.9 + 0.1 * e)
    }

    tilt.x += (tilt.tx - tilt.x) * Math.min(1, dt * 3)
    tilt.z += (tilt.tz - tilt.z) * Math.min(1, dt * 3)
    root.rotation.x = tilt.x
    root.rotation.z = tilt.z

    if (!dragging) {
      dragVel *= Math.pow(0.04, dt)
      spin.rotation.y += (spinVel + dragVel) * dt
    }

    ember.intensity = 3.5 + Math.sin(t * 2.3) * 0.45 + Math.sin(t * 5.7) * 0.25
    if (embers) embers.update(dt)

    render()
    raf = requestAnimationFrame(frame)
  }

  function start() {
    if (reducedMotion) {
      root.position.y = 0
      root.scale.setScalar(1)
      render()
      return
    }
    if (!raf && !disposed) {
      timer.update() // сбрасываем дельту после паузы
      raf = requestAnimationFrame(frame)
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

  start()
  onStatus({ ready: true, source: 'procedural' })

  // ---------- optional user model ----------
  loadUserModel()
    .then((model) => {
      if (!model || disposed) return
      spin.remove(dish)
      disposeObject(dish)
      dish = model
      spin.add(dish)
      if (reducedMotion) render()
      onStatus({ ready: true, source: 'model' })
    })
    .catch((err) => {
      // Модель есть, но не читается — оставляем процедурное блюдо.
      console.info('[Ember & Olive] Модель блюда не загружена, показана заглушка:', err?.message || err)
    })

  // ---------- cleanup ----------
  return function dispose() {
    disposed = true
    if (raf) cancelAnimationFrame(raf)
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
// Загрузка пользовательской модели
// =====================================================================
async function loadUserModel() {
  if (!dishModel.available) return null
  const res = await fetch(dishModel.url, { cache: 'no-cache' })
  if (!res.ok) return null
  const buf = await res.arrayBuffer()
  if (buf.byteLength < 12) return null
  const magic = String.fromCharCode(...new Uint8Array(buf, 0, 4))
  if (magic !== 'glTF') return null

  const [{ GLTFLoader }, { DRACOLoader }, { MeshoptDecoder }] = await Promise.all([
    import('three/examples/jsm/loaders/GLTFLoader.js'),
    import('three/examples/jsm/loaders/DRACOLoader.js'),
    import('three/examples/jsm/libs/meshopt_decoder.module.js'),
  ])
  const loader = new GLTFLoader()
  const draco = new DRACOLoader() // декодер Vite кладёт в сборку сам (через import.meta.url)
  loader.setDRACOLoader(draco)
  loader.setMeshoptDecoder(MeshoptDecoder)

  const gltf = await loader.parseAsync(buf, '/models/')
  draco.dispose()
  const model = gltf.scene

  // Нормализация: диаметр ≈ 3.3 единицы, центр в нуле, дно на полу.
  const box = new THREE.Box3().setFromObject(model)
  const size = box.getSize(new THREE.Vector3())
  const span = Math.max(size.x, size.z) || 1
  model.scale.setScalar(3.3 / span)
  box.setFromObject(model)
  const center = box.getCenter(new THREE.Vector3())
  model.position.x -= center.x
  model.position.z -= center.z
  model.position.y -= box.min.y

  model.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true
      o.receiveShadow = true
    }
  })
  return model
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

/** Окружение для отражений: тёмный зал, тёплый софтбокс сверху, окно, оливковый контровой, подвесные лампы. */
function buildRestaurantEnv() {
  const env = new THREE.Scene()
  const room = new THREE.Mesh(
    new THREE.BoxGeometry(24, 12, 24),
    new THREE.MeshBasicMaterial({ color: 0x24170f, side: THREE.BackSide }),
  )
  room.position.y = 5
  env.add(room)

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(24, 24), new THREE.MeshBasicMaterial({ color: 0x3b2618 }))
  floor.rotation.x = -Math.PI / 2
  floor.position.y = -0.8
  env.add(floor)

  const origin = new THREE.Vector3(0, 0, 0)
  const panel = (w, h, color, intensity, x, y, z) => {
    const mat = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide })
    mat.color.multiplyScalar(intensity)
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat)
    m.position.set(x, y, z)
    m.lookAt(origin)
    env.add(m)
  }
  panel(7, 5, 0xffe6cc, 6, 4, 9, 5) // основной софтбокс
  panel(10, 4, 0xfff0dc, 2.2, -11, 4, 0.5) // окно
  panel(5, 3, 0xd6dba6, 2.6, -6, 4, -9) // контровой
  panel(4, 2, 0xff9a55, 1.6, 8, 1.5, -2) // отсвет очага

  const bulbGeo = new THREE.SphereGeometry(0.35, 16, 12)
  ;[
    [-3, 8, -2],
    [2.5, 8.5, -4],
    [0, 7.5, 3.5],
  ].forEach(([x, y, z]) => {
    const mat = new THREE.MeshBasicMaterial({ color: 0xffb070 })
    mat.color.multiplyScalar(40)
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
