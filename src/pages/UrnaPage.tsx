import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import logo from '../assets/logo-cbb.png'
import { identificar, votar, type Identificacao, type MotivoVoto } from '../lib/cipaService'
import { apenasDigitos, cpfValido, formatarDataHora, mascararCpf } from '../lib/cpf'

/*
  Máquina de estados da urna. Duas pessoas usam o mesmo tablet em sequência:

    repouso → cpf → identidade   (MESÁRIO: confere quem é)
            → entrega                        ← aqui o tablet troca de mão
            → cedula → comprovante           (ELEITOR: vota sozinho)

  Quem toca "Começar a votar" na tela de entrega é o ELEITOR, já com o tablet na mão — assim
  o mesário nunca vê a cédula. E o comprovante não mostra em quem a pessoa votou, porque é
  justamente a tela que volta para a mão do mesário.
*/

type Etapa =
  | 'repouso'
  | 'cpf'
  | 'identidade'
  | 'entrega'
  | 'cedula'
  | 'confirmar'
  | 'comprovante'
  | 'nao_votou'

type Aviso = { titulo: string; corpo: string; tom: 'erro' | 'neutro' }

const INATIVIDADE_MS = 90_000

export default function UrnaPage() {
  const { slug = '' } = useParams()

  const [etapa, setEtapa] = useState<Etapa>('repouso')
  const [cpf, setCpf] = useState('')
  const [pessoa, setPessoa] = useState<Identificacao | null>(null)
  const [escolhido, setEscolhido] = useState<string | null>(null)
  const [comprovante, setComprovante] = useState<{ protocolo: string; votouEm: string } | null>(null)
  const [aviso, setAviso] = useState<Aviso | null>(null)
  const [ocupado, setOcupado] = useState(false)

  const tituloRef = useRef<HTMLHeadingElement>(null)

  const reiniciar = useCallback(() => {
    setEtapa('repouso')
    setCpf('')
    setPessoa(null)
    setEscolhido(null)
    setComprovante(null)
    setAviso(null)
    setOcupado(false)
  }, [])

  // Abandono: a pessoa é chamada no rádio e larga o tablet com um nome já selecionado.
  // Descarta tudo sem registrar nada — o CPF continua apto a votar depois.
  useEffect(() => {
    const telaDoEleitor = etapa === 'entrega' || etapa === 'cedula' || etapa === 'confirmar'
    if (!telaDoEleitor) return

    const timer = window.setTimeout(() => {
      setEscolhido(null)
      setPessoa(null)
      setCpf('')
      setEtapa('nao_votou')
    }, INATIVIDADE_MS)

    return () => window.clearTimeout(timer)
  }, [etapa, escolhido])

  // Foco no título a cada troca de tela: quem usa leitor de tela precisa ouvir onde está.
  useEffect(() => {
    tituloRef.current?.focus()
  }, [etapa])

  function digitar(d: string) {
    setAviso(null)
    setCpf((atual) => (apenasDigitos(atual).length >= 11 ? atual : mascararCpf(atual + d)))
  }

  function apagar() {
    setAviso(null)
    setCpf((atual) => mascararCpf(apenasDigitos(atual).slice(0, -1)))
  }

  async function continuar() {
    if (!cpfValido(cpf)) {
      setAviso({
        titulo: 'Esse CPF não está certo.',
        corpo: 'Confira os números com a pessoa.',
        tom: 'erro',
      })
      return
    }

    setOcupado(true)
    const r = await identificar(slug, cpf)
    setOcupado(false)

    if (!r.ok) {
      setAviso(avisoDeIdentificacao(r.motivo, r.nome, r.abertura, r.encerramento))
      return
    }

    if (r.dados.candidatos.length === 0) {
      setAviso({
        titulo: 'Esta eleição ainda não tem candidatos.',
        corpo: 'A urna só abre depois que a comissão cadastrar os nomes.',
        tom: 'neutro',
      })
      return
    }

    if (r.dados.jaVotou) {
      setPessoa(r.dados)
      setComprovante({ protocolo: r.dados.protocolo ?? '—', votouEm: r.dados.votouEm ?? '' })
      setAviso({
        titulo: `${primeiroNome(r.dados.nome)} já votou.`,
        corpo: 'Cada pessoa vota uma vez.',
        tom: 'neutro',
      })
      setEtapa('comprovante')
      return
    }

    setPessoa(r.dados)
    setEtapa('identidade')
  }

  async function confirmarVoto() {
    if (!pessoa) return
    setOcupado(true)
    const r = await votar(slug, cpf, escolhido ? [escolhido] : [])
    setOcupado(false)

    if (!r.ok) {
      // Se o voto entrou e só a resposta se perdeu, a nova tentativa cai aqui com o
      // protocolo original — a pessoa vê o comprovante dela, não um erro.
      if (r.motivo === 'ja_votou' && r.protocolo) {
        setComprovante({ protocolo: r.protocolo, votouEm: r.votouEm ?? '' })
        setEtapa('comprovante')
        return
      }
      setAviso(avisoDeVoto(r.motivo))
      setEtapa('cedula')
      return
    }

    setComprovante({ protocolo: r.protocolo, votouEm: r.votouEm })
    setCpf('') // o CPF não fica em memória depois do voto
    setEtapa('comprovante')
  }

  return (
    <div className="urna-pagina">
      <div className="faixa-marca" aria-hidden="true" />
      <div className="urna-conteudo">
        <img src={logo} alt="CBB Asfaltos" className="logo-login" width={1128} height={500} />

        {etapa === 'repouso' && (
          <>
            <p className="urna-micro">Urna · Eleição da CIPA</p>
            <h1 className="urna-titulo" tabIndex={-1} ref={tituloRef}>
              Pronto para o próximo eleitor
            </h1>
            <p className="urna-corpo">Confira quem é a pessoa antes de entregar o tablet.</p>
            <button type="button" className="botao-urna" onClick={() => setEtapa('cpf')}>
              Identificar eleitor
            </button>
            <Link to="comissao" className="botao-texto botao-bloco-centro">
              Comissão
            </Link>
          </>
        )}

        {etapa === 'cpf' && (
          <>
            <h1 className="urna-titulo" tabIndex={-1} ref={tituloRef}>
              Quem vai votar?
            </h1>
            <p className="urna-apoio">CPF do eleitor</p>
            <div className={`visor-cpf ${cpf ? '' : 'visor-cpf-vazio'}`} aria-live="polite">
              {cpf || '000.000.000-00'}
            </div>

            {aviso && <AvisoNaTela aviso={aviso} />}

            <div className="teclado">
              {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
                <button key={d} type="button" className="tecla" onClick={() => digitar(d)}>
                  {d}
                </button>
              ))}
              <span />
              <button type="button" className="tecla" onClick={() => digitar('0')}>
                0
              </button>
              <button type="button" className="tecla tecla-apagar" onClick={apagar}>
                Apagar
              </button>
            </div>

            <button
              type="button"
              className="botao-urna"
              onClick={continuar}
              disabled={ocupado || !cpfValido(cpf)}
            >
              {ocupado ? 'Verificando…' : 'Continuar'}
            </button>
            {!cpfValido(cpf) && !ocupado && (
              <p className="urna-apoio">Faltam números para continuar.</p>
            )}

            <button type="button" className="botao-texto botao-bloco-centro" onClick={reiniciar}>
              Voltar
            </button>
          </>
        )}

        {etapa === 'identidade' && pessoa && (
          <>
            <p className="urna-micro">Confira com a pessoa</p>
            <p className="urna-destaque">{pessoa.nome}</p>
            <p className="urna-apoio">
              {[pessoa.setor, `CPF ${mascararParcial(cpf)}`].filter(Boolean).join(' · ')}
            </p>
            <h1 className="urna-titulo" tabIndex={-1} ref={tituloRef}>
              É você?
            </h1>
            <button type="button" className="botao-urna" onClick={() => setEtapa('entrega')}>
              Confirmar e entregar o tablet
            </button>
            <button
              type="button"
              className="botao-urna botao-urna-secundario"
              onClick={() => {
                setCpf('')
                setPessoa(null)
                setEtapa('cpf')
              }}
            >
              Não é essa pessoa
            </button>
          </>
        )}

        {etapa === 'entrega' && pessoa && (
          <>
            <p className="urna-micro">Entregue o tablet</p>
            <h1 className="urna-titulo" tabIndex={-1} ref={tituloRef}>
              {primeiroNome(pessoa.nome)}, agora é com você.
            </h1>
            {/* Esta frase é o produto: é o que faz a pessoa acreditar que pode votar de verdade. */}
            <div className="alerta-pagina">
              O seu voto é secreto. Ninguém vai saber em quem você votou — nem a comissão, nem a
              empresa, nem o seu chefe.
            </div>
            <p className="urna-corpo">Quando o tablet estiver na sua mão, toque no botão verde.</p>
            <button
              type="button"
              className="botao-urna botao-urna-decisivo"
              onClick={() => setEtapa('cedula')}
            >
              Começar a votar
            </button>
            <button type="button" className="botao-texto botao-bloco-centro" onClick={reiniciar}>
              Cancelar (organizador)
            </button>
          </>
        )}

        {etapa === 'cedula' && pessoa && (
          <>
            <p className="urna-micro">Escolha 1 nome</p>
            <h1 className="urna-titulo" tabIndex={-1} ref={tituloRef}>
              Em quem você quer votar?
            </h1>
            <p className="urna-corpo">Toque no nome da pessoa. Você escolhe só uma.</p>
            {pessoa.candidatos.length > 4 && (
              <p className="urna-apoio">
                São {pessoa.candidatos.length} nomes. Role a tela para ver todos.
              </p>
            )}

            {aviso && <AvisoNaTela aviso={aviso} />}

            <ul className="lista-candidatos" role="radiogroup" aria-label="Candidatos">
              {pessoa.candidatos.map((c) => {
                const ativo = escolhido === c.id
                return (
                  <li key={c.id}>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={ativo}
                      className={`candidato ${ativo ? 'candidato-escolhido' : ''}`}
                      onClick={() => setEscolhido(ativo ? null : c.id)}
                    >
                      {c.numero !== null && <span className="candidato-numero">{c.numero}</span>}
                      <span className="candidato-dados">
                        <span className="candidato-nome">{c.nome}</span>
                        {c.setor && <span className="candidato-setor"> {c.setor}</span>}
                      </span>
                      {ativo && <span className="candidato-marca">✓ Escolhido</span>}
                    </button>
                  </li>
                )
              })}

              {pessoa.eleicao.permiteBranco && (
                <li>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={escolhido === 'branco'}
                    className={`candidato candidato-branco ${
                      escolhido === 'branco' ? 'candidato-escolhido' : ''
                    }`}
                    onClick={() => setEscolhido(escolhido === 'branco' ? null : 'branco')}
                  >
                    <span className="candidato-dados">
                      <span className="candidato-nome">Votar em branco</span>
                      <span className="candidato-setor">Não quero votar em nenhum nome.</span>
                    </span>
                    {escolhido === 'branco' && <span className="candidato-marca">✓ Escolhido</span>}
                  </button>
                </li>
              )}
            </ul>

            <div className="barra-acao">
              {escolhido ? (
                <button
                  type="button"
                  className="botao-urna botao-urna-decisivo"
                  onClick={() => setEtapa('confirmar')}
                >
                  Confirmar voto
                </button>
              ) : (
                <p className="barra-acao-dica">Toque em um nome para continuar.</p>
              )}
            </div>

            <button
              type="button"
              className="botao-texto botao-bloco-centro"
              onClick={() => setEtapa('nao_votou')}
            >
              Sair sem votar
            </button>
          </>
        )}

        {etapa === 'comprovante' && comprovante && (
          <>
            <div className={aviso ? 'painel-neutro' : 'painel-sucesso'}>
              <h1 className="urna-titulo" tabIndex={-1} ref={tituloRef}>
                {aviso ? aviso.titulo : 'Seu voto foi registrado.'}
              </h1>
              {aviso && <p className="urna-corpo">{aviso.corpo}</p>}

              <div className="cartao-protocolo">
                <p className="urna-micro">Número do comprovante</p>
                <p className="codigo-protocolo">{comprovante.protocolo}</p>
                <p className="urna-apoio">Registrado em {formatarDataHora(comprovante.votouEm)}</p>
              </div>

              <p className="urna-corpo">Agora devolva o tablet ao organizador.</p>
            </div>
            <button
              type="button"
              className="botao-urna botao-urna-secundario"
              onClick={reiniciar}
            >
              Organizador: chamar próximo eleitor
            </button>
          </>
        )}

        {etapa === 'nao_votou' && (
          <>
            <div className="painel-neutro">
              <h1 className="urna-titulo" tabIndex={-1} ref={tituloRef}>
                Você não votou.
              </h1>
              <p className="urna-corpo">Você continua na lista e pode votar depois.</p>
              <p className="urna-corpo">Devolva o tablet ao organizador.</p>
            </div>
            <button type="button" className="botao-urna botao-urna-secundario" onClick={reiniciar}>
              Organizador: chamar próximo eleitor
            </button>
          </>
        )}
      </div>

      {etapa === 'confirmar' && pessoa && (
        <ModalConfirmacao
          nome={
            escolhido === 'branco'
              ? 'Voto em branco'
              : pessoa.candidatos.find((c) => c.id === escolhido)?.nome ?? ''
          }
          numero={
            escolhido === 'branco'
              ? null
              : pessoa.candidatos.find((c) => c.id === escolhido)?.numero ?? null
          }
          ocupado={ocupado}
          onConfirmar={confirmarVoto}
          onCorrigir={() => setEtapa('cedula')}
        />
      )}
    </div>
  )
}

function ModalConfirmacao({
  nome,
  numero,
  ocupado,
  onConfirmar,
  onCorrigir,
}: {
  nome: string
  numero: number | null
  ocupado: boolean
  onConfirmar: () => void
  onCorrigir: () => void
}) {
  const tituloRef = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    tituloRef.current?.focus()
    function aoTeclar(ev: KeyboardEvent) {
      if (ev.key === 'Escape' && !ocupado) onCorrigir()
    }
    window.addEventListener('keydown', aoTeclar)
    return () => window.removeEventListener('keydown', aoTeclar)
  }, [ocupado, onCorrigir])

  return (
    // Toque fora não fecha: o polegar encosta na borda o tempo todo com o tablet na mão.
    <div className="modal-fundo" role="dialog" aria-modal="true" aria-labelledby="titulo-confirmar">
      <div className="modal">
        <p className="urna-micro">Confira seu voto</p>
        <h2 id="titulo-confirmar" className="urna-titulo" tabIndex={-1} ref={tituloRef}>
          {numero !== null ? `${numero} — ${nome}` : nome}
        </h2>
        <div className="alerta-pagina">
          Depois de confirmar, não é possível mudar o seu voto.
        </div>
        <div className="acoes-modal" style={{ flexDirection: 'column' }}>
          <button
            type="button"
            className="botao-urna botao-urna-decisivo"
            onClick={onConfirmar}
            disabled={ocupado}
          >
            {ocupado ? 'Registrando…' : 'Confirmar meu voto'}
          </button>
          <button
            type="button"
            className="botao-urna botao-urna-secundario"
            onClick={onCorrigir}
            disabled={ocupado}
          >
            Corrigir
          </button>
        </div>
      </div>
    </div>
  )
}

function AvisoNaTela({ aviso }: { aviso: Aviso }) {
  return (
    <div className={`alerta-pagina ${aviso.tom === 'erro' ? 'erro' : ''}`} role="status">
      <strong>{aviso.titulo}</strong> {aviso.corpo}
    </div>
  )
}

function primeiroNome(nome: string): string {
  return nome.trim().split(/\s+/)[0] ?? nome
}

function mascararParcial(cpf: string): string {
  const d = apenasDigitos(cpf)
  if (d.length !== 11) return cpf
  return `***.${d.slice(3, 6)}.${d.slice(6, 9)}-**`
}

function avisoDeIdentificacao(
  motivo: string,
  nome?: string,
  abertura?: string,
  encerramento?: string
): Aviso {
  switch (motivo) {
    case 'nao_encontrado':
      return {
        titulo: 'Esse CPF não está na lista de quem pode votar.',
        corpo: 'Confira os números. Se estiverem certos, fale com a comissão.',
        tom: 'erro',
      }
    case 'nao_apto':
      // O motivo não aparece aqui de propósito: pode ser afastamento ou data de admissão,
      // e isso não se expõe na frente da fila. A comissão consulta na própria tela dela.
      return {
        titulo: `${nome ? primeiroNome(nome) : 'Essa pessoa'} não pode votar nesta eleição.`,
        corpo: 'A comissão vai explicar o motivo.',
        tom: 'neutro',
      }
    case 'nao_comecou':
      return {
        titulo: 'A votação ainda não começou.',
        corpo: abertura ? `Começa em ${formatarDataHora(abertura)}.` : '',
        tom: 'neutro',
      }
    case 'encerrada':
      return {
        titulo: 'A votação foi encerrada.',
        corpo: encerramento
          ? `Encerrou em ${formatarDataHora(encerramento)}. A comissão vai divulgar o resultado.`
          : 'A comissão vai divulgar o resultado.',
        tom: 'neutro',
      }
    case 'muitas_tentativas':
      return {
        titulo: 'Muitas tentativas seguidas.',
        corpo: 'Espere alguns minutos e tente de novo, ou chame a comissão.',
        tom: 'erro',
      }
    case 'cpf_invalido':
      return { titulo: 'Esse CPF não está certo.', corpo: 'Confira os números.', tom: 'erro' }
    case 'eleicao_inexistente':
      return {
        titulo: 'Este tablet não está configurado para nenhuma eleição.',
        corpo: 'Fale com a TI.',
        tom: 'erro',
      }
    default:
      return {
        titulo: 'Sem conexão com o sistema.',
        corpo: 'A urna não pode receber votos agora. Não entregue o tablet.',
        tom: 'erro',
      }
  }
}

function avisoDeVoto(motivo: MotivoVoto): Aviso {
  if (motivo === 'erro') {
    return {
      titulo: 'Seu voto NÃO foi registrado.',
      corpo: 'Toque em confirmar de novo. Se não funcionar, chame o organizador.',
      tom: 'erro',
    }
  }
  return avisoDeIdentificacao(motivo)
}
