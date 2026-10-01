import logo from './assets/logo-cbb.png'

// Placeholder do passo 2 do plano: existe para fechar cedo o risco de deploy
// (base do Vite x basename do Router x 404.html). As telas da urna entram no passo 4,
// depois da especificação do cbb-ux-design.
export default function App() {
  return (
    <div className="pagina-login">
      <div className="cartao-login">
        <img src={logo} alt="CBB Asfaltos" className="logo-login" width={1128} height={500} />
        <h1>Eleição da CIPA</h1>
        <p className="subtitulo">
          O sistema de votação está sendo preparado. Quando a votação for aberta, esta página
          passa a pedir o seu CPF.
        </p>
      </div>
    </div>
  )
}
