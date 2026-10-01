import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import UrnaPage from './pages/UrnaPage'
import ComissaoPage from './pages/ComissaoPage'

// O basename precisa casar com o `base` do vite.config.ts (lá com barra no fim, aqui sem) e
// com o pathSegmentsToKeep do public/404.html. Os três discordando = página branca ou 404.
export default function App() {
  return (
    <BrowserRouter basename="/cbb-votacao-cipa">
      <Routes>
        {/* Cada eleição tem seu slug. O tablet abre direto na urna certa. */}
        <Route path="/:slug" element={<UrnaPage />} />
        <Route path="/:slug/comissao" element={<ComissaoPage />} />
        <Route path="*" element={<Navigate to="/cipa-2026" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
