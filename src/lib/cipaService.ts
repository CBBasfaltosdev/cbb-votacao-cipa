// Única camada que fala com o Supabase. As telas em src/pages não sabem que ele existe —
// mesmo contrato do bookingService do cbb-agendamentos.
//
// Regra que não pode ser quebrada aqui: nenhuma função devolve, em nenhuma hipótese, o
// candidato escolhido por alguém. O comprovante é protocolo + horário, nada mais. Quem
// recebe o tablet de volta é o mesário (NR-5 5.4.4, voto secreto).

import { supabase } from './supabaseClient'

export type Candidato = {
  id: string
  numero: number | null
  nome: string
  setor: string | null
  /** nome do arquivo em public/candidatos (ex.: '1.webp'), ou null se nao houver foto */
  foto: string | null
}

export type Eleicao = {
  nome: string
  estabelecimento: string
  encerramento: string
  votosPorEleitor: number
  permiteBranco: boolean
}

export type MotivoIdentificar =
  | 'eleicao_inexistente'
  | 'nao_comecou'
  | 'encerrada'
  | 'cpf_invalido'
  | 'nao_encontrado'
  | 'nao_apto'
  | 'muitas_tentativas'
  | 'erro'

export type MotivoVoto =
  | MotivoIdentificar
  | 'ja_votou'
  | 'excedeu_votos'
  | 'candidato_repetido'
  | 'candidato_invalido'
  | 'branco_nao_permitido'

export type Identificacao = {
  nome: string
  setor: string | null
  jaVotou: boolean
  protocolo: string | null
  votouEm: string | null
  eleicao: Eleicao
  candidatos: Candidato[]
}

export type RespostaIdentificar =
  | { ok: true; dados: Identificacao }
  | { ok: false; motivo: MotivoIdentificar; nome?: string; abertura?: string; encerramento?: string }

export type RespostaVoto =
  | { ok: true; protocolo: string; votouEm: string; nome: string }
  | { ok: false; motivo: MotivoVoto; protocolo?: string; votouEm?: string }

function mapearEleicao(e: Record<string, unknown>): Eleicao {
  return {
    nome: e.nome as string,
    estabelecimento: e.estabelecimento as string,
    encerramento: e.encerramento as string,
    votosPorEleitor: (e.votos_por_eleitor as number) ?? 1,
    permiteBranco: (e.permite_branco as boolean) ?? true,
  }
}

export async function identificar(slug: string, cpf: string): Promise<RespostaIdentificar> {
  const { data, error } = await supabase.rpc('cipa_identificar', { p_slug: slug, p_cpf: cpf })
  if (error) return { ok: false, motivo: 'erro' }

  const r = data as Record<string, unknown>
  if (!r?.ok) {
    return {
      ok: false,
      motivo: (r?.motivo as MotivoIdentificar) ?? 'erro',
      nome: r?.nome as string | undefined,
      abertura: r?.abertura as string | undefined,
      encerramento: r?.encerramento as string | undefined,
    }
  }

  return {
    ok: true,
    dados: {
      nome: r.nome as string,
      setor: (r.setor as string) ?? null,
      jaVotou: Boolean(r.ja_votou),
      protocolo: (r.protocolo as string) ?? null,
      votouEm: (r.votou_em as string) ?? null,
      eleicao: mapearEleicao(r.eleicao as Record<string, unknown>),
      candidatos: ((r.candidatos as Record<string, unknown>[]) ?? []).map((c) => ({
        id: c.id as string,
        numero: (c.numero as number) ?? null,
        nome: c.nome as string,
        setor: (c.setor as string) ?? null,
        foto: (c.foto as string) ?? null,
      })),
    },
  }
}

// candidatos = [] significa voto em branco (é diferente de "não votou", que nem chega aqui).
export async function votar(
  slug: string,
  cpf: string,
  candidatos: string[]
): Promise<RespostaVoto> {
  const { data, error } = await supabase.rpc('cipa_votar', {
    p_slug: slug,
    p_cpf: cpf,
    p_candidatos: candidatos.length > 0 ? candidatos : null,
  })
  if (error) return { ok: false, motivo: 'erro' }

  const r = data as Record<string, unknown>
  if (!r?.ok) {
    return {
      ok: false,
      motivo: (r?.motivo as MotivoVoto) ?? 'erro',
      protocolo: r?.protocolo as string | undefined,
      votouEm: r?.votou_em as string | undefined,
    }
  }

  return {
    ok: true,
    protocolo: r.protocolo as string,
    votouEm: r.votou_em as string,
    nome: r.nome as string,
  }
}

// ----------------------------------------------------------------- comissão

export type PainelQuorum = {
  nome: string
  aberta: boolean
  encerramento: string
  aptos: number
  votantes: number
  percentual: number
  atingiuMetade: boolean
  atingiuUmTerco: boolean
  resultadoPublicado: boolean
}

export type EleitorNaLista = {
  nome: string
  matricula: string
  setor: string | null
  apto: boolean
  votou: boolean
  votouEm: string | null
  protocolo: string | null
}

export async function entrarComoComissao(email: string, senha: string): Promise<void> {
  const { error } = await supabase.auth.signInWithPassword({
    email: email.trim().toLowerCase(),
    password: senha,
  })
  if (error) throw error
}

export async function sair(): Promise<void> {
  await supabase.auth.signOut()
}

export async function sessaoAtiva(): Promise<boolean> {
  const { data } = await supabase.auth.getSession()
  return Boolean(data.session)
}

// A autorização de verdade mora dentro da função no banco (cipa_e_comissao). Aqui só
// traduzimos o 42501 em "não é da comissão" para a tela poder redirecionar.
export async function painel(slug: string): Promise<PainelQuorum | 'sem_acesso' | null> {
  const { data, error } = await supabase.rpc('cipa_painel', { p_slug: slug })
  if (error) return error.code === '42501' ? 'sem_acesso' : null
  const r = data as Record<string, unknown>
  if (!r?.ok) return null
  return {
    nome: r.nome as string,
    aberta: Boolean(r.aberta),
    encerramento: r.encerramento as string,
    aptos: r.aptos as number,
    votantes: r.votantes as number,
    percentual: Number(r.percentual ?? 0),
    atingiuMetade: Boolean(r.atingiu_metade),
    atingiuUmTerco: Boolean(r.atingiu_um_terco),
    resultadoPublicado: Boolean(r.resultado_publicado),
  }
}

export type LinhaPlacar = {
  numero: number | null
  nome: string
  setor: string | null
  foto: string | null
  votos: number
  /** false = saiu da disputa, mas aparece porque recebeu votos antes de sair */
  ativo: boolean
  /** funcao indicada pela comissao (nao e resultado de voto) */
  funcao: string | null
}

export type Parcial = {
  nome: string
  aberta: boolean
  encerrada: boolean
  urnaFechada: boolean
  vagasEfetivos: number
  vagasSuplentes: number
  totalVotos: number
  brancos: number
  aptos: number
  placar: LinhaPlacar[]
}

export async function parcial(slug: string): Promise<Parcial | null> {
  const { data, error } = await supabase.rpc('cipa_parcial', { p_slug: slug })
  if (error) return null
  const r = data as Record<string, unknown>
  if (!r?.ok) return null
  return {
    nome: r.nome as string,
    aberta: Boolean(r.aberta),
    encerrada: Boolean(r.encerrada),
    urnaFechada: Boolean(r.urna_fechada),
    vagasEfetivos: (r.vagas_efetivos as number) ?? 1,
    vagasSuplentes: (r.vagas_suplentes as number) ?? 1,
    totalVotos: (r.total_votos as number) ?? 0,
    brancos: (r.brancos as number) ?? 0,
    aptos: (r.aptos as number) ?? 0,
    placar: ((r.placar as Record<string, unknown>[]) ?? []).map((l) => ({
      numero: (l.numero as number) ?? null,
      nome: l.nome as string,
      setor: (l.setor as string) ?? null,
      foto: (l.foto as string) ?? null,
      votos: (l.votos as number) ?? 0,
      ativo: l.ativo !== false,
      funcao: (l.funcao as string) ?? null,
    })),
  }
}

export async function listaEleitores(slug: string): Promise<EleitorNaLista[]> {
  const { data, error } = await supabase.rpc('cipa_lista_eleitores', { p_slug: slug })
  if (error) throw error
  return ((data as Record<string, unknown>[]) ?? []).map((e) => ({
    nome: e.nome as string,
    matricula: e.matricula as string,
    setor: (e.setor as string) ?? null,
    apto: Boolean(e.apto),
    votou: Boolean(e.votou),
    votouEm: (e.votou_em as string) ?? null,
    protocolo: (e.protocolo as string) ?? null,
  }))
}
