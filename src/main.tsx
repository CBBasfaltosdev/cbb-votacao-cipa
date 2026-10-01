import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// A ordem importa: a fonte antes dos tokens, e os tokens antes do CSS base,
// senão as variáveis não existem quando as regras globais são avaliadas.
import '@fontsource-variable/manrope'
import './styles/tokens.css'
import './index.css'
import App from './App'
import './App.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
