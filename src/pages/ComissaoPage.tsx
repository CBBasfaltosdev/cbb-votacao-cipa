import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import logo from '../assets/logo-cbb.png'
import {
  entrarComoComissao,
  parcial,
  listaEleitores,
  painel,
  sair,
  sessaoAtiva,
  type EleitorNaLista,
  type PainelQuorum,
  type Parcial,
} from '../lib/cipaService'
import { formatarDataHora } from '../lib/cpf'

/*
  Tela de trabalho do Rogério, usada no mesmo tablet entre uma rodada e outra.

  Duas abas, e a padrão é "Faltam" de propósito: o trabalho dele durante a votação é ir atrás
  de quem ainda não votou, não admirar quem já votou.

  Nenhuma contagem por candidato aparece aqui. Mostrar parcial durante a votação influenciaria
  a eleição em curso — a apuração é ato formal, acompanhado, depois do encerramento (NR-5 5.5.3-i).
*/

type Aba = 'faltam' | 'votaram'

export default function ComissaoPage() {
  const { slug = '' } = useParams()

  const [autenticado, setAutenticado] = useState<boolean | null>(null)
  const [quorum, setQuorum] = useState<PainelQuorum | null>(null)
  const [semAcesso, setSemAcesso] = useState(false)
  const [eleitores, setEleitores] = useState<EleitorNaLista[]>([])
  const [placar, setPlacar] = useState<Parcial | null>(null)
  const [aba, setAba] = useState<Aba>('faltam')
  const [modoImpressao, setModoImpressao] = useState<'lista' | 'resultado'>('lista')
  const [filtro, setFiltro] = useState('')
  const [erro, setErro] = useState<string | null>(null)
  const [carregando, setCarregando] = useState(false)

  // Só a resposta mais recente pode aplicar o resultado: o auto-refresh de 30s e um toque
  // manual em "Atualizar" podem estar em voo ao mesmo tempo.
  const chamadaAtualRef = useRef(0)

  const carregar = useCallback(async () => {
    const chamada = ++chamadaAtualRef.current
    setCarregando(true)
    setErro(null)
    try {
      const p = await painel(slug)
      if (chamada !== chamadaAtualRef.current) return

      if (p === 'sem_acesso') {
        setSemAcesso(true)
        return
      }
      if (p === null) {
        setErro('Não foi possível carregar o painel.')
        return
      }
      setQuorum(p)

      const lista = await listaEleitores(slug)
      if (chamada !== chamadaAtualRef.current) return
      setEleitores(lista)

      const pl = await parcial(slug)
      if (chamada !== chamadaAtualRef.current) return
      setPlacar(pl)
    } catch {
      if (chamada === chamadaAtualRef.current) setErro('Não foi possível carregar a lista.')
    } finally {
      if (chamada === chamadaAtualRef.current) setCarregando(false)
    }
  }, [slug])

  useEffect(() => {
    sessaoAtiva().then((ativa) => {
      setAutenticado(ativa)
      if (ativa) carregar()
    })
  }, [carregar])

  useEffect(() => {
    if (!autenticado || semAcesso) return
    const t = window.setInterval(carregar, 30_000)
    return () => window.clearInterval(t)
  }, [autenticado, semAcesso, carregar])

  function imprimir(modo: 'lista' | 'resultado') {
    setModoImpressao(modo)
    // espera o React aplicar o atributo antes de abrir a janela de impressao
    window.setTimeout(() => window.print(), 80)
  }

  const aptos = useMemo(() => eleitores.filter((e) => e.apto), [eleitores])
  const votaram = useMemo(() => aptos.filter((e) => e.votou), [aptos])
  const faltam = useMemo(() => aptos.filter((e) => !e.votou), [aptos])

  const visiveis = useMemo(() => {
    const base = aba === 'faltam' ? faltam : votaram
    const termo = filtro.trim().toLowerCase()
    if (!termo) return base
    return base.filter(
      (e) =>
        e.nome.toLowerCase().includes(termo) ||
        e.matricula.toLowerCase().includes(termo) ||
        (e.setor ?? '').toLowerCase().includes(termo)
    )
  }, [aba, faltam, votaram, filtro])

  if (autenticado === null) return <p className="mensagem">Carregando…</p>

  if (!autenticado) {
    return <LoginComissao onEntrou={() => { setAutenticado(true); carregar() }} />
  }

  if (semAcesso) {
    return (
      <div className="pagina-evento">
        <h1>Acesso restrito</h1>
        <p className="descricao">
          Esta conta não faz parte da comissão eleitoral desta eleição. Fale com a TI se isso
          estiver errado.
        </p>
        <button
          type="button"
          className="botao-secundario"
          onClick={() => sair().then(() => setAutenticado(false))}
        >
          Sair
        </button>
      </div>
    )
  }

  return (
    <div className="pagina-evento" data-impressao={modoImpressao}>
      <Link to={`/${slug}`} className="voltar sem-impressao">
        ← Voltar para a urna
      </Link>
      <h1>{quorum?.nome ?? 'Eleição da CIPA'}</h1>

      {erro && <p className="mensagem erro">{erro}</p>}

      {quorum && (
        <>
          <section className="sem-impressao" aria-label="Participação">
            <p className="urna-micro">Participação</p>
            <p className="urna-destaque">
              {quorum.votantes} <span className="urna-apoio">de {aptos.length || quorum.aptos} aptos</span>
            </p>
            <div className="barra-quorum">
              <div
                className="barra-quorum-preenchida"
                style={{ width: `${Math.min(quorum.percentual, 100)}%` }}
              />
            </div>
            <p className="urna-apoio">{quorum.percentual.toLocaleString('pt-BR')}% dos aptos</p>

            {/*
              A NR-5 (5.5.4 e 5.5.4.1) não tem um limite só: é uma escada por dia de votação.
              1º dia vale com metade; se não atingir, prorroga para o dia seguinte somando os
              votos já dados e passa a valer com um terço; no 3º dia vale com qualquer número.
              Por isso os dois marcadores aparecem com o significado escrito ao lado.
            */}
            <div className="marcadores-quorum">
              <p className="marcador-quorum">
                {quorum.atingiuMetade ? '✓' : '○'} Metade dos aptos — mínimo para apurar no 1º dia
              </p>
              <p className="marcador-quorum">
                {quorum.atingiuUmTerco ? '✓' : '○'} Um terço — mínimo no 2º dia, se houver prorrogação
              </p>
            </div>

            <div className="acoes-comissao">
              <button type="button" className="botao-secundario" onClick={carregar} disabled={carregando}>
                {carregando ? 'Atualizando…' : 'Atualizar agora'}
              </button>
              <span className="urna-apoio">Atualiza sozinho a cada 30 segundos.</span>
            </div>
          </section>

          {placar && <Placar dados={placar} onImprimir={() => imprimir('resultado')} />}
          {placar && placar.encerrada && <FolhaResultado dados={placar} />}

          <section className="secao-comissao sem-impressao" aria-label="Lista de presença">
            <p className="urna-micro">Lista de presença</p>
            <div className="acoes-comissao">
              <button
                type="button"
                className={`aba ${aba === 'faltam' ? 'aba-ativa' : ''}`}
                onClick={() => setAba('faltam')}
              >
                Faltam ({faltam.length})
              </button>
              <button
                type="button"
                className={`aba ${aba === 'votaram' ? 'aba-ativa' : ''}`}
                onClick={() => setAba('votaram')}
              >
                Já votaram ({votaram.length})
              </button>
              <button
                type="button"
                className="botao-secundario empurra"
                onClick={() => imprimir('lista')}
              >
                Imprimir lista
              </button>
            </div>
          </section>

          {/* Cabeçalho que só existe no papel — vira anexo da ata. */}
          <div className="apenas-impressao folha-lista">
            <p className="data-evento">
              {quorum.nome} — lista de presença — {aptos.length} aptos, {votaram.length} votaram (
              {quorum.percentual.toLocaleString('pt-BR')}%) — impresso em{' '}
              {new Date().toLocaleString('pt-BR')}
            </p>
          </div>

          <label className="campo-busca sem-impressao">
            Buscar por nome, matrícula ou setor
            <input value={filtro} onChange={(e) => setFiltro(e.target.value)} placeholder="Buscar…" />
          </label>

          <div className="tabela-scroll">
            {visiveis.map((e) => (
              <div className="linha-eleitor" key={e.matricula}>
                <span className="linha-eleitor-dados">
                  <span className="linha-eleitor-nome">{e.nome}</span>
                  <span className="urna-micro">
                    {[e.setor, e.matricula].filter(Boolean).join(' · ')}
                  </span>
                </span>
                <span className={`selo-situacao ${e.votou ? 'selo-votou' : ''}`}>
                  {e.votou ? `✓ Votou ${formatarDataHora(e.votouEm).split('às')[1]?.trim() ?? ''}` : 'Falta'}
                </span>
              </div>
            ))}
            {visiveis.length === 0 && (
              <p className="estado-vazio">
                {aba === 'faltam'
                  ? filtro
                    ? 'Nenhum nome encontrado.'
                    : 'Todo mundo já votou.'
                  : 'Ninguém votou ainda.'}
              </p>
            )}
          </div>

          <button
            type="button"
            className="botao-texto sem-impressao"
            onClick={() => sair().then(() => setAutenticado(false))}
          >
            Sair da conta da comissão
          </button>
        </>
      )}
    </div>
  )
}

function LoginComissao({ onEntrou }: { onEntrou: () => void }) {
  const [email, setEmail] = useState('')
  const [senha, setSenha] = useState('')
  const [erro, setErro] = useState<string | null>(null)
  const [enviando, setEnviando] = useState(false)

  async function enviar(ev: React.FormEvent) {
    ev.preventDefault()
    setErro(null)
    if (!email.trim() || !senha) {
      setErro('Preencha e-mail e senha.')
      return
    }
    setEnviando(true)
    try {
      await entrarComoComissao(email, senha)
      onEntrou()
    } catch {
      setErro('E-mail ou senha incorretos.')
    } finally {
      setEnviando(false)
    }
  }

  return (
    <div className="pagina-login">
      <div className="cartao-login">
        <img src={logo} alt="cbb Asfaltos" className="logo-login" width={1128} height={500} />
        <form onSubmit={enviar}>
          <h1>Comissão eleitoral</h1>
          <p className="subtitulo">
            Acesso restrito a quem organiza a eleição. Não é por aqui que se vota.
          </p>
          <label>
            E-mail
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
          </label>
          <label>
            Senha
            <input type="password" value={senha} onChange={(e) => setSenha(e.target.value)} />
          </label>
          {erro && <p className="mensagem erro">{erro}</p>}
          <button type="submit" className="botao-primario botao-bloco" disabled={enviando}>
            {enviando ? 'Entrando…' : 'Entrar'}
          </button>
        </form>
      </div>
    </div>
  )
}

/*
  Placar por candidato.

  Mostrado durante a votação a pedido expresso do solicitante (01/10/2026), ciente de que a
  NR-5 trata a apuração como ato formal após o encerramento (5.5.3-i) e de que quem acessa
  este painel é candidato na eleição. Fica o aviso na própria tela para que a comissão saiba
  o que está vendo e registre em ata. O sigilo individual continua intacto: isto é contagem
  agregada, não existe como ligar um voto a um eleitor.
*/
function Placar({ dados, onImprimir }: { dados: Parcial; onImprimir: () => void }) {
  const vagas = dados.vagasEfetivos + dados.vagasSuplentes
  const houveVoto = dados.totalVotos > 0
  const lider = dados.placar[0]
  const empateNaLideranca =
    houveVoto && dados.placar.filter((l) => l.votos === lider?.votos).length > 1

  return (
    <section className="secao-comissao sem-impressao" aria-label="Apuração parcial">
      <p className="urna-micro">
        {dados.encerrada ? 'Resultado' : 'Parcial — votação em andamento'}
      </p>

      {!houveVoto && <p className="estado-vazio">Nenhum voto registrado ainda.</p>}

      {houveVoto && (
        <>
          <p className="urna-destaque">
            {dados.totalVotos} <span className="urna-apoio">votos apurados</span>
          </p>

          {!dados.encerrada && (
            <div className="alerta-pagina">
              Resultado <strong>parcial</strong>, com a votação ainda aberta. Pela NR-5 a apuração
              oficial é feita depois do encerramento. Quem está em primeiro agora pode não ser o
              eleito no fim.
            </div>
          )}

          {empateNaLideranca && (
            <div className="alerta-pagina">
              Há <strong>empate</strong> na liderança. O critério de desempate precisa estar
              publicado no edital antes do fim da votação.
            </div>
          )}

          <ul className="placar-lista">
            {dados.placar.map((l, i) => {
              const eleito = dados.encerrada && l.ativo && i < dados.vagasEfetivos
              const suplente = dados.encerrada && l.ativo && i >= dados.vagasEfetivos && i < vagas
              const pct = dados.totalVotos > 0 ? (l.votos * 100) / dados.totalVotos : 0
              return (
                <li
                  key={l.numero ?? l.nome}
                  className={`placar-linha ${eleito ? 'placar-eleito' : ''} ${
                    suplente ? 'placar-suplente' : ''
                  }`}
                >
                  <span className="placar-posicao">{i + 1}º</span>
                  {l.foto && (
                    <img
                      className="placar-foto"
                      src={`${import.meta.env.BASE_URL}candidatos/${l.foto}`}
                      alt=""
                      width={48}
                      height={48}
                    />
                  )}
                  <span className="placar-dados">
                    <span className="placar-nome">
                      {l.numero !== null ? `${l.numero} — ` : ''}
                      {l.nome}
                    </span>
                    <span className="urna-micro">{l.setor}</span>
                    {/* o selo é textual: não depende de cor para se entender */}
                    {eleito && <span className="selo-posicao selo-eleito">Eleito</span>}
                    {suplente && <span className="selo-posicao">Suplente</span>}
                    {!l.ativo && <span className="selo-posicao">Fora da disputa</span>}
                    {l.funcao && <span className="selo-posicao">Função: {l.funcao}</span>}
                  </span>
                  <span className="placar-votos">
                    <span className="placar-numero-votos">{l.votos}</span>
                    <span className="urna-micro">{pct.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%</span>
                  </span>
                </li>
              )
            })}
          </ul>

          {dados.encerrada && (
            <div className="acoes-comissao sem-impressao">
              <button type="button" className="botao-urna botao-urna-secundario" onClick={onImprimir}>
                Imprimir resultado / salvar em PDF
              </button>
            </div>
          )}

          {dados.encerrada && !dados.urnaFechada && (
            <div className="alerta-pagina erro sem-impressao">
              A urna ainda não foi fechada. Antes de divulgar o resultado, a comissão precisa
              executar o fechamento — é o que embaralha os votos registrados e impede reconstruir
              a ordem em que foram dados.
            </div>
          )}
        </>
      )}
    </section>
  )
}


/*
  Folha de resultado para postar (mural, intranet ou PDF). Só aparece depois do encerramento
  e só no papel — na tela o painel acima já mostra a mesma informação.

  Duas colunas SEPARADAS de propósito: "votos" é o resultado da votação; "função" é a
  indicação da comissão. Pela NR-5 (5.4.5) o vice-presidente é escolhido pelos titulares
  eleitos entre si, não sai de voto — misturar as duas coisas na mesma coluna faria o papel
  afirmar que o voto elegeu um cargo que ele não elege.
*/
function FolhaResultado({ dados }: { dados: Parcial }) {
  const linhas = dados.placar.filter((l) => l.votos > 0 || l.ativo)

  // Posição por votos, com empate: quem tem a mesma votação ocupa a mesma posição. Mostrar
  // "1º" e "2º" para quem empatou faria o mural afirmar que um venceu o outro.
  const posicoes = linhas.map((l) => linhas.findIndex((x) => x.votos === l.votos) + 1)
  const temEmpate = new Set(posicoes).size < linhas.length
  const pct = (v: number) =>
    dados.totalVotos > 0
      ? ((v * 100) / dados.totalVotos).toLocaleString('pt-BR', { maximumFractionDigits: 1 })
      : '0'

  return (
    <section className="apenas-impressao folha-resultado" aria-label="Resultado para publicação">
      <img src={logo} alt="cbb Asfaltos" className="folha-logo" />
      <h2 className="folha-titulo">{dados.nome} — Resultado</h2>
      <p className="data-evento">
        cbb Asfaltos — Curitiba/PR · {dados.totalVotos} votos apurados de {dados.aptos} eleitores
        aptos ({dados.aptos > 0 ? ((dados.totalVotos * 100) / dados.aptos).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) : 0}% de participação)
      </p>
      <table className="tabela-admin">
        <thead>
          <tr>
            <th>Posição</th>
            <th>Nº</th>
            <th>Candidato</th>
            <th>Setor</th>
            <th>Votos</th>
            <th>%</th>
            <th>Função indicada pela comissão</th>
          </tr>
        </thead>
        <tbody>
          {linhas.map((l, i) => (
            <tr key={l.numero ?? l.nome}>
              <td>{posicoes[i]}º{posicoes.filter((x) => x === posicoes[i]).length > 1 ? ' (empate)' : ''}</td>
              <td>{l.numero ?? '—'}</td>
              <td>{l.nome}</td>
              <td>{l.setor ?? '—'}</td>
              <td>{l.votos}</td>
              <td>{pct(l.votos)}%</td>
              <td>{l.funcao ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {temEmpate && (
        <p className="urna-apoio">
          Candidatos com a mesma votação ocupam a mesma posição; dentro do empate, a ordem da
          tabela segue o número do candidato e não indica preferência.
        </p>
      )}
      <p className="urna-apoio">
        As funções indicadas pela comissão não decorrem do número de votos. Resultado gerado em{' '}
        {new Date().toLocaleString('pt-BR')}.
      </p>
    </section>
  )
}
