// Espelho em TypeScript da função cipa_cpf_valido do banco. Existe para derrubar erro de
// digitação na própria tela, sem ida ao servidor — o que também evita gastar tentativa do
// limite anti-força-bruta com quem só errou um dígito de luva.

export function apenasDigitos(valor: string): string {
  return valor.replace(/\D/g, '')
}

export function mascararCpf(valor: string): string {
  const d = apenasDigitos(valor).slice(0, 11)
  if (d.length <= 3) return d
  if (d.length <= 6) return `${d.slice(0, 3)}.${d.slice(3)}`
  if (d.length <= 9) return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6)}`
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`
}

export function cpfValido(valor: string): boolean {
  const d = apenasDigitos(valor)
  if (d.length !== 11) return false
  // 111.111.111-11 e afins passam no cálculo dos dígitos, mas não são CPF de ninguém.
  if (/^(\d)\1{10}$/.test(d)) return false

  let soma = 0
  for (let i = 0; i < 9; i++) soma += Number(d[i]) * (10 - i)
  let d1 = 11 - (soma % 11)
  if (d1 >= 10) d1 = 0

  soma = 0
  for (let i = 0; i < 10; i++) soma += Number(d[i]) * (11 - i)
  let d2 = 11 - (soma % 11)
  if (d2 >= 10) d2 = 0

  return d1 === Number(d[9]) && d2 === Number(d[10])
}

// "01/10/2026 às 14:32" no fuso de Curitiba, independente do fuso do aparelho.
export function formatarDataHora(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  const data = d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })
  const hora = d.toLocaleTimeString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    hour: '2-digit',
    minute: '2-digit',
  })
  return `${data} às ${hora}`
}
