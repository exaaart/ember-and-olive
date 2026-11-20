/**
 * Чистые расчёты нормализации 3D-модели и кадрирования камеры.
 * Вынесены отдельно от Three.js для детерминированного модульного тестирования.
 */

/**
 * Вычисляет масштаб и смещение, чтобы модель вписывалась в целевой диаметр
 * и максимальную высоту, была отцентрирована по X/Z и стояла дном на y = 0.
 *
 * @param {{ min: { x: number, y: number, z: number }, max: { x: number, y: number, z: number } }} bounds
 * @param {{ targetSpan?: number, maxHeight?: number }} [options]
 */
export function computeModelNormalization(bounds, options = {}) {
  const targetSpan = options.targetSpan ?? 3.1
  const maxHeight = options.maxHeight ?? 2.2

  const sizeX = Math.max(0, bounds.max.x - bounds.min.x)
  const sizeY = Math.max(0, bounds.max.y - bounds.min.y)
  const sizeZ = Math.max(0, bounds.max.z - bounds.min.z)

  const span = Math.max(sizeX, sizeZ, 1e-4)
  let scale = targetSpan / span
  if (sizeY * scale > maxHeight && sizeY > 1e-4) {
    scale = maxHeight / sizeY
  }

  const centerX = (bounds.min.x + bounds.max.x) / 2
  const centerZ = (bounds.min.z + bounds.max.z) / 2

  const normalizedWidth = sizeX * scale
  const normalizedHeight = sizeY * scale
  const normalizedDepth = sizeZ * scale

  return {
    scale,
    offsetX: -centerX * scale,
    offsetY: -bounds.min.y * scale,
    offsetZ: -centerZ * scale,
    normalizedWidth,
    normalizedHeight,
    normalizedDepth,
    radius: Math.max(normalizedWidth, normalizedDepth) / 2,
  }
}

/**
 * Вычисляет позицию камеры и точку прицеливания так, чтобы модель с учётом высоты
 * (например, блюдо со стеклянным клошем) полностью помещалась в кадр с воздухом.
 *
 * @param {{
 *   aspect: number,
 *   fovDeg: number,
 *   modelRadius: number,
 *   modelHeight: number,
 *   isSmall: boolean,
 * }} params
 */
export function computeCameraRig({ aspect, fovDeg, modelRadius, modelHeight, isSmall }) {
  const safeAspect = Math.max(0.3, aspect || 1)
  const halfFovRad = ((fovDeg / 2) * Math.PI) / 180
  const tanHalfFov = Math.tan(halfFovRad)

  const elevDeg = isSmall ? 26 : 22
  const elevationRad = (elevDeg * Math.PI) / 180

  const targetY = Math.max(0.12, modelHeight * (isSmall ? 0.42 : 0.34))
  const fitRadiusX = modelRadius * 1.18
  const fitHalfY = Math.max(modelRadius * 0.68, modelHeight * 0.66)

  const distForWidth = fitRadiusX / (tanHalfFov * safeAspect)
  const distForHeight = fitHalfY / tanHalfFov
  const distance = Math.max(distForWidth, distForHeight) + modelRadius * 0.25

  return {
    distance,
    elevationRad,
    targetY,
    cameraY: Math.sin(elevationRad) * distance + targetY,
    cameraZ: Math.cos(elevationRad) * distance,
  }
}
