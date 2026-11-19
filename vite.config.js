import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Tells the client whether /public/models/restaurant-dish.glb exists.
 * The site requests the model only when the file is really there, so a missing
 * model never produces a 404 or a console error — the procedural dish is shown instead.
 * In dev the flag updates on its own when the file is added or removed.
 */
function dishModelFlag() {
  const VIRTUAL_ID = 'virtual:dish-model'
  const RESOLVED_ID = '\0' + VIRTUAL_ID
  const modelPath = path.resolve(process.cwd(), 'public/models/restaurant-dish.glb')

  return {
    name: 'dish-model-flag',
    resolveId(id) {
      if (id === VIRTUAL_ID) return RESOLVED_ID
    },
    load(id) {
      if (id !== RESOLVED_ID) return
      let available = false
      try {
        available = fs.statSync(modelPath).size > 12
      } catch {
        available = false
      }
      return `export default ${JSON.stringify({ available, url: '/models/restaurant-dish.glb' })}`
    },
    configureServer(server) {
      server.watcher.add(path.dirname(modelPath))
      const refresh = (file) => {
        if (path.resolve(file) !== modelPath) return
        const mod = server.moduleGraph.getModuleById(RESOLVED_ID)
        if (mod) server.moduleGraph.invalidateModule(mod)
        server.ws.send({ type: 'full-reload' })
      }
      server.watcher.on('add', refresh)
      server.watcher.on('unlink', refresh)
      server.watcher.on('change', refresh)
    },
  }
}

export default defineConfig({
  plugins: [react(), dishModelFlag()],
  // Заранее оптимизируем зависимости, чтобы первый запуск dev-сервера не перезагружал страницу на лету
  optimizeDeps: {
    include: [
      'react',
      'react-dom/client',
      'three',
      'three/examples/jsm/utils/BufferGeometryUtils.js',
      'three/examples/jsm/geometries/RoundedBoxGeometry.js',
      'three/examples/jsm/loaders/GLTFLoader.js',
      'three/examples/jsm/loaders/DRACOLoader.js',
      'three/examples/jsm/libs/meshopt_decoder.module.js',
    ],
  },
  build: {
    chunkSizeWarningLimit: 900,
  },
})
