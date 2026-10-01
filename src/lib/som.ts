/*
  Bipe de confirmação do voto, no espírito da urna eletrônica.

  O som é gerado na hora pela Web Audio API, não é um arquivo baixado: a urna real emite um
  tom puro, então sintetizar dá o mesmo resultado sem peso de download, sem depender de a
  rede entregar um .mp3 no meio da votação e sem usar áudio de terceiro.

  O som é um reforço, nunca a única confirmação — quem não ouvir (surdez, barulho de fábrica,
  aparelho no mudo) continua vendo a tela de comprovante com protocolo e horário.
*/

let contexto: AudioContext | null = null

function obterContexto(): AudioContext | null {
  if (typeof window === 'undefined') return null
  try {
    if (!contexto) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!Ctor) return null
      contexto = new Ctor()
    }
    // Navegador costuma suspender o áudio até haver um toque do usuário; como isto só é
    // chamado depois de um clique, dá para retomar aqui.
    if (contexto.state === 'suspended') void contexto.resume()
    return contexto
  } catch {
    return null
  }
}

function tom(ctx: AudioContext, hz: number, inicio: number, duracao: number, volume = 0.22) {
  const osc = ctx.createOscillator()
  const ganho = ctx.createGain()
  osc.type = 'square' // onda quadrada: o timbre "eletrônico" da urna, não um apito limpo
  osc.frequency.value = hz

  // Sobe e desce rápido para não estalar no alto-falante do tablet.
  ganho.gain.setValueAtTime(0, inicio)
  ganho.gain.linearRampToValueAtTime(volume, inicio + 0.012)
  ganho.gain.setValueAtTime(volume, inicio + duracao - 0.03)
  ganho.gain.linearRampToValueAtTime(0, inicio + duracao)

  osc.connect(ganho)
  ganho.connect(ctx.destination)
  osc.start(inicio)
  osc.stop(inicio + duracao + 0.02)
}

/** Toca o bipe de "voto registrado". Falha em silêncio se o aparelho não deixar tocar áudio. */
export function tocarConfirmacao() {
  const ctx = obterContexto()
  if (!ctx) return
  try {
    const agora = ctx.currentTime
    // Dois bipes curtos e um longo — padrão que o ouvido brasileiro associa a "confirmado".
    tom(ctx, 1200, agora, 0.09)
    tom(ctx, 1200, agora + 0.14, 0.09)
    tom(ctx, 1500, agora + 0.3, 0.55)
  } catch {
    // Sem som não é erro: a confirmação visual continua valendo.
  }
}
