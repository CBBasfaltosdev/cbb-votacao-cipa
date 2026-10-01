import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Supabase não configurado: defina VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY')
}

// Este app divide o mesmo projeto Supabase com o cbb-agendamentos. Se um dia os dois forem
// publicados no mesmo domínio do GitHub Pages, passam a dividir também o mesmo localStorage —
// e a chave de sessão padrão (sb-<ref>-auth-token) colidiria: entrar na comissão da CIPA
// derrubaria a sessão do outro app. Uma chave própria evita isso desde já.
export const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { storageKey: 'cbb-votacao-cipa-auth' },
})
