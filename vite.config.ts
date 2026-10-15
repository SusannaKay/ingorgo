import { defineConfig } from 'vite';

// Logica e grafica in file separati: a ogni deploy si ricaricano solo quelli cambiati.
export default defineConfig({
  base: './',
  build: {
    rollupOptions: {
      // three arriva dalla CDN tramite importmap (index.html)
      external: [/^three/],
      output: {
        manualChunks(id) {
          if (id.includes('/src/game/')) return 'game';
          if (id.includes('/src/render/')) return 'render';
        },
      },
    },
  },
});
