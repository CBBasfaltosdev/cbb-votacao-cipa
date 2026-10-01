-- Login apenas por CPF (decisão do Rogério, 2026-09-30) + correção do furo de sigilo do xmin.
--
-- POR QUE O HASH MUDA: até aqui `cpf_hash` era bcrypt com salt por linha, que serve para
-- CONFERIR um CPF quando já se sabe qual linha olhar (o login era matrícula + CPF). Com login
-- só por CPF é preciso ACHAR a linha pelo CPF, e bcrypt obrigaria varrer a tabela inteira
-- testando linha a linha (~100ms cada). Passa a ser HMAC-SHA256 determinístico com pepper no
-- Vault, com índice único. É assumidamente mais fraco contra quem obtenha dump + pepper —
-- é o preço do login por CPF, e está registrado no plano e na ata.
--
-- Rollback: drop das funções cipa_pepper, cipa_cpf_valido, cipa_cpf_hmac, cipa_bloqueado;
--           drop table cipa_tentativas;
--           alter table cipa_eleitores drop column cpf_hmac, add column cpf_hash text;
--           alter table cipa_eleicoes drop column urna_fechada_em;
--           (as tabelas estão vazias — não há dado a preservar)

-- ----------------------------------------------------------------- pepper

-- Gerado uma vez só. Sobrescrever este segredo invalida cipa_eleitores.cpf_hmac inteira:
-- ninguém mais consegue votar até a lista do RH ser reimportada.
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'cipa_cpf_pepper') then
    perform vault.create_secret(
      encode(extensions.gen_random_bytes(32), 'hex'),
      'cipa_cpf_pepper',
      'Pepper do HMAC do CPF dos eleitores da CIPA. Trocar invalida cipa_eleitores.cpf_hmac — só troque junto com a reimportacao da lista do RH.'
    );
  end if;
end $$;

create or replace function cipa_pepper()
returns text
language plpgsql
stable
security definer
set search_path = public, vault, extensions
as $$
declare p text;
begin
  select decrypted_secret into p from vault.decrypted_secrets where name = 'cipa_cpf_pepper';
  -- Falhar alto e claro. Um pepper ausente que devolvesse NULL faria toda identificação
  -- retornar "nao_encontrado" — o pior modo de falha possível no dia da eleição.
  if p is null then
    raise exception 'pepper cipa_cpf_pepper ausente no Vault' using errcode = 'P0001';
  end if;
  return p;
end;
$$;

-- --------------------------------------------------------- validação de CPF

-- Dígitos verificadores. Derruba o erro de digitação antes de virar tentativa de login
-- (não entope o limite de tentativas) e reduz o espaço de enumeração para 1/100.
create or replace function cipa_cpf_valido(p_cpf text)
returns boolean
language plpgsql
immutable
as $$
declare
  v text := regexp_replace(coalesce(p_cpf,''), '\D', '', 'g');
  s int; d1 int; d2 int; i int;
begin
  if length(v) <> 11 then return false; end if;
  if v ~ '^(\d)\1{10}$' then return false; end if;

  s := 0;
  for i in 1..9 loop s := s + substr(v,i,1)::int * (11 - i); end loop;
  d1 := 11 - (s % 11);
  if d1 >= 10 then d1 := 0; end if;

  s := 0;
  for i in 1..10 loop s := s + substr(v,i,1)::int * (12 - i); end loop;
  d2 := 11 - (s % 11);
  if d2 >= 10 then d2 := 0; end if;

  return d1 = substr(v,10,1)::int and d2 = substr(v,11,1)::int;
end;
$$;

create or replace function cipa_cpf_hmac(p_cpf text)
returns text
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare v text := regexp_replace(coalesce(p_cpf,''), '\D', '', 'g');
begin
  if length(v) <> 11 then return null; end if;
  return encode(extensions.hmac(v, cipa_pepper(), 'sha256'), 'hex');
end;
$$;

revoke all on function cipa_pepper()        from public, anon, authenticated;
revoke all on function cipa_cpf_hmac(text)  from public, anon, authenticated;

-- ------------------------------------------------------------------ esquema

alter table cipa_eleitores drop column if exists cpf_hash;
alter table cipa_eleitores add  column if not exists cpf_hmac text;

create unique index if not exists cipa_eleitores_cpf_uk on cipa_eleitores (eleicao_id, cpf_hmac);

comment on column cipa_eleitores.cpf_hmac is
  'HMAC-SHA256(digitos do CPF, pepper do Vault). E ao mesmo tempo identificador e autenticador. NUNCA guardar o CPF em claro.';
comment on column cipa_eleitores.matricula is
  'Fora do fluxo de voto (login e so por CPF). Serve para conferir a lista com o RH.';

-- Marca do ritual de fechamento da urna (ver cipa_fechar_urna, migration 0005).
alter table cipa_eleicoes add column if not exists urna_fechada_em timestamptz;

-- --------------------------------------------------- limite de tentativas

create table if not exists cipa_tentativas (
  id          bigserial primary key,
  eleicao_id  uuid not null references cipa_eleicoes(id) on delete cascade,
  ip          inet,
  cpf_hmac    text,
  sucesso     boolean not null,
  quando      timestamptz not null default now()
);

create index if not exists cipa_tentativas_ip_idx  on cipa_tentativas (eleicao_id, ip, quando desc);
create index if not exists cipa_tentativas_cpf_idx on cipa_tentativas (eleicao_id, cpf_hmac, quando desc);

alter table cipa_tentativas enable row level security;
revoke all on cipa_tentativas from anon, authenticated;

-- O chão de fábrica inteiro sai por um único IP público (NAT). Um limite por IP baixo
-- derrubaria a eleição no primeiro turno de gente errando o CPF — por isso o limite por IP
-- é alto de propósito, e a trava fina é por (IP, CPF), que é o que barra o ataque dirigido.
create or replace function cipa_bloqueado(p_eleicao uuid, p_ip inet, p_cpf_hmac text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    (select count(*) from cipa_tentativas
      where eleicao_id = p_eleicao and not sucesso
        and cpf_hmac is not distinct from p_cpf_hmac
        and quando > now() - interval '15 minutes') >= 5
    or
    (p_ip is not null and (select count(*) from cipa_tentativas
      where eleicao_id = p_eleicao and not sucesso and ip = p_ip
        and quando > now() - interval '15 minutes') >= 60);
$$;

revoke all on function cipa_bloqueado(uuid, inet, text) from public, anon, authenticated;

-- ------------------------------------------- assinaturas antigas (matrícula)

drop function if exists cipa_votar(text, text, text, uuid[]);
drop function if exists cipa_comprovante(text, text, text);
drop function if exists cipa_lista_votantes(text);
