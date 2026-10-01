import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// O `base` precisa casar com o `basename` do BrowserRouter (sem a barra final) e com o
// `pathSegmentsToKeep` do public/404.html. Se os três discordarem, a página abre em branco
// ou todo deep link cai em 404.
export default defineConfig({
  base: '/cbb-votacao-cipa/',
  plugins: [react()],
})
