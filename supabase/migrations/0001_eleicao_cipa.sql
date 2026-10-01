-- Eleição da CIPA — modelo de urna.
--
-- REGRA ESTRUTURAL DESTE SCHEMA (não "otimize" isso depois):
-- `cipa_votantes` (quem votou) e `cipa_votos` (em quem se votou) NÃO TÊM LIGAÇÃO entre si.
-- Não existe FK, não existe id em comum, e `cipa_votos` não guarda hora — só a data, porque a
-- NR-5 item 5.5.4 computa os votos por dia na prorrogação. Hora exata no voto permitiria
-- correlacionar com o carimbo de `cipa_votantes` e descobrir em quem cada um votou, que é
-- exatamente o que a NR-5 proíbe (5.4.4 escrutínio secreto; 5.5.3-h voto secreto;
-- 5.5.3-j confidencialidade do registro dos votos).
--
-- Rollback: drop table cipa_votos, cipa_votantes, cipa_eleitores, cipa_candidatos,
--           cipa_comissao, cipa_eleicoes cascade; + drop das funções cipa_*.

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------- eleição

create table cipa_eleicoes (
  id                    uuid primary key default gen_random_uuid(),
  slug                  text not null unique,
  nome                  text not null,
  estabelecimento       text not null,
  abertura              timestamptz not null,
  encerramento          timestamptz not null,
  vagas_efetivos        int not null default 1,
  vagas_suplentes       int not null default 1,
  votos_por_eleitor     int not null default 1 check (votos_por_eleitor >= 1),
  permite_branco        boolean not null default true,
  resultado_publicado   boolean not null default false,
  criado_em             timestamptz not null default now(),
  check (encerramento > abertura)
);

comment on column cipa_eleicoes.resultado_publicado is
  'Enquanto false, nem a comissão vê a contagem — evita apuração parcial influenciando a eleição em curso (NR-5 5.5.3-i: apuração é ato formal, acompanhado).';

-- ------------------------------------------------------------- candidatos

create table cipa_candidatos (
  id           uuid primary key default gen_random_uuid(),
  eleicao_id   uuid not null references cipa_eleicoes(id) on delete cascade,
  numero       int,
  nome         text not null,
  setor        text,
  ordem        int not null default 0,
  ativo        boolean not null default true,
  unique (eleicao_id, numero)
);

-- --------------------------------------------------------------- eleitores
-- Lista nominal vinda do RH. Base do quórum (NR-5 5.5.4) e do controle de voto único.

create table cipa_eleitores (
  id           uuid primary key default gen_random_uuid(),
  eleicao_id   uuid not null references cipa_eleicoes(id) on delete cascade,
  matricula    text not null,
  nome         text not null,
  setor        text,
  cpf_hash     text,                          -- bcrypt. NUNCA o CPF em claro.
  apto         boolean not null default true,
  unique (eleicao_id, matricula)
);

-- ------------------------------------------------------- lista de presença

create table cipa_votantes (
  id           uuid primary key default gen_random_uuid(),
  eleicao_id   uuid not null references cipa_eleicoes(id) on delete cascade,
  eleitor_id   uuid not null references cipa_eleitores(id) on delete cascade,
  protocolo    text not null,
  votou_em     timestamptz not null default now(),
  ip           inet,
  user_agent   text,
  unique (eleicao_id, eleitor_id)             -- é isto que impede votar duas vezes
);

-- -------------------------------------------------------------------- urna

create table cipa_votos (
  id             uuid primary key default gen_random_uuid(),
  eleicao_id     uuid not null references cipa_eleicoes(id) on delete cascade,
  candidato_id   uuid references cipa_candidatos(id) on delete restrict,  -- null = branco
  dia            date not null default (now() at time zone 'America/Sao_Paulo')::date
  -- proposital: sem eleitor_id, sem hora, sem sequência.
);

-- -------------------------------------------------------- comissão eleitoral

create table cipa_comissao (
  email      text primary key,
  nome       text,
  criado_em  timestamptz not null default now()
);

comment on table cipa_comissao is
  'Allowlist de quem acompanha/apura (NR-5 5.5.2). Separada da tabela admins do sistema de agendamentos de propósito: são produtos e responsabilidades diferentes.';

-- ---------------------------------------------------------------------- RLS
-- Nenhuma tabela é lida direto pelo cliente. Tudo passa por função security definer.

alter table cipa_eleicoes   enable row level security;
alter table cipa_candidatos enable row level security;
alter table cipa_eleitores  enable row level security;
alter table cipa_votantes   enable row level security;
alter table cipa_votos      enable row level security;
alter table cipa_comissao   enable row level security;

revoke all on cipa_eleicoes, cipa_candidatos, cipa_eleitores,
              cipa_votantes, cipa_votos, cipa_comissao
  from anon, authenticated;
