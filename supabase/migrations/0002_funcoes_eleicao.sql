-- Funções da eleição. O cliente NUNCA lê tabela direto — só chama estas funções.
-- Rollback: drop function cipa_eleicao_publica, cipa_votar, cipa_comprovante,
--           cipa_painel, cipa_apuracao, cipa_lista_votantes;

-- Tela de votação: dados públicos da eleição + cédula. Não expõe eleitor nem voto.
create or replace function cipa_eleicao_publica(p_slug text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  e cipa_eleicoes%rowtype;
begin
  select * into e from cipa_eleicoes where slug = p_slug;
  if not found then
    return jsonb_build_object('ok', false, 'motivo', 'eleicao_inexistente');
  end if;

  return jsonb_build_object(
    'ok', true,
    'eleicao', jsonb_build_object(
      'slug', e.slug,
      'nome', e.nome,
      'estabelecimento', e.estabelecimento,
      'abertura', e.abertura,
      'encerramento', e.encerramento,
      'votos_por_eleitor', e.votos_por_eleitor,
      'permite_branco', e.permite_branco,
      'vagas_efetivos', e.vagas_efetivos,
      'vagas_suplentes', e.vagas_suplentes,
      'aberta', now() between e.abertura and e.encerramento
    ),
    'candidatos', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', c.id, 'numero', c.numero, 'nome', c.nome, 'setor', c.setor)
               order by c.ordem, c.numero, c.nome)
      from cipa_candidatos c
      where c.eleicao_id = e.id and c.ativo
    ), '[]'::jsonb)
  );
end;
$$;

-- Registra o voto. Participação e voto entram na mesma transação, em tabelas sem vínculo.
create or replace function cipa_votar(
  p_slug        text,
  p_matricula   text,
  p_cpf         text,
  p_candidatos  uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  e            cipa_eleicoes%rowtype;
  v_eleitor    cipa_eleitores%rowtype;
  v_qtd        int;
  v_mat        text := regexp_replace(coalesce(p_matricula,''), '^0+', '');
  v_cpf        text := regexp_replace(coalesce(p_cpf,''), '\D', '', 'g');
  v_protocolo  text;
  v_cand       uuid;
  v_ip         inet;
  v_ua         text;
begin
  select * into e from cipa_eleicoes where slug = p_slug;
  if not found then
    return jsonb_build_object('ok', false, 'motivo', 'eleicao_inexistente');
  end if;

  if now() < e.abertura then
    return jsonb_build_object('ok', false, 'motivo', 'nao_comecou');
  end if;
  if now() > e.encerramento then
    return jsonb_build_object('ok', false, 'motivo', 'encerrada');
  end if;

  -- Eleitor: compara matrícula ignorando zeros à esquerda (o funcionário digita "12",
  -- a folha traz "0012"). Se a lista do RH tiver as duas formas, é erro de cadastro.
  select count(*) into v_qtd
  from cipa_eleitores
  where eleicao_id = e.id and regexp_replace(matricula, '^0+', '') = v_mat;

  if v_qtd = 0 then
    return jsonb_build_object('ok', false, 'motivo', 'nao_encontrado');
  elsif v_qtd > 1 then
    return jsonb_build_object('ok', false, 'motivo', 'matricula_ambigua');
  end if;

  select * into v_eleitor
  from cipa_eleitores
  where eleicao_id = e.id and regexp_replace(matricula, '^0+', '') = v_mat;

  if not v_eleitor.apto then
    return jsonb_build_object('ok', false, 'motivo', 'nao_apto');
  end if;

  if v_eleitor.cpf_hash is null then
    return jsonb_build_object('ok', false, 'motivo', 'sem_cpf_cadastrado');
  end if;
  if length(v_cpf) <> 11 or v_eleitor.cpf_hash <> crypt(v_cpf, v_eleitor.cpf_hash) then
    return jsonb_build_object('ok', false, 'motivo', 'cpf_incorreto');
  end if;

  -- Cédula
  if p_candidatos is null or array_length(p_candidatos, 1) is null then
    if not e.permite_branco then
      return jsonb_build_object('ok', false, 'motivo', 'branco_nao_permitido');
    end if;
  else
    if array_length(p_candidatos, 1) > e.votos_por_eleitor then
      return jsonb_build_object('ok', false, 'motivo', 'excedeu_votos');
    end if;
    if (select count(distinct x) from unnest(p_candidatos) x) <> array_length(p_candidatos, 1) then
      return jsonb_build_object('ok', false, 'motivo', 'candidato_repetido');
    end if;
    if exists (
      select 1 from unnest(p_candidatos) x
      where not exists (
        select 1 from cipa_candidatos c
        where c.id = x and c.eleicao_id = e.id and c.ativo
      )
    ) then
      return jsonb_build_object('ok', false, 'motivo', 'candidato_invalido');
    end if;
  end if;

  v_protocolo := upper(encode(gen_random_bytes(5), 'hex'));

  begin
    v_ip := nullif(split_part(
              coalesce(current_setting('request.headers', true)::json ->> 'x-forwarded-for', ''),
              ',', 1), '')::inet;
    v_ua := current_setting('request.headers', true)::json ->> 'user-agent';
  exception when others then
    v_ip := null; v_ua := null;
  end;

  -- Lista de presença. O unique (eleicao_id, eleitor_id) é o que impede votar duas vezes.
  begin
    insert into cipa_votantes (eleicao_id, eleitor_id, protocolo, ip, user_agent)
    values (e.id, v_eleitor.id, v_protocolo, v_ip, v_ua);
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'motivo', 'ja_votou');
  end;

  -- Urna. Nada aqui aponta para o eleitor acima.
  if p_candidatos is null or array_length(p_candidatos, 1) is null then
    insert into cipa_votos (eleicao_id, candidato_id) values (e.id, null);
  else
    foreach v_cand in array p_candidatos loop
      insert into cipa_votos (eleicao_id, candidato_id) values (e.id, v_cand);
    end loop;
  end if;

  return jsonb_build_object(
    'ok', true,
    'protocolo', v_protocolo,
    'eleitor', v_eleitor.nome
  );
end;
$$;

-- Consulta de participação (não revela voto). Serve para a pessoa reaver o protocolo.
create or replace function cipa_comprovante(p_slug text, p_matricula text, p_cpf text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  e         cipa_eleicoes%rowtype;
  v_eleitor cipa_eleitores%rowtype;
  v_mat     text := regexp_replace(coalesce(p_matricula,''), '^0+', '');
  v_cpf     text := regexp_replace(coalesce(p_cpf,''), '\D', '', 'g');
  v_prot    text;
  v_quando  timestamptz;
begin
  select * into e from cipa_eleicoes where slug = p_slug;
  if not found then
    return jsonb_build_object('ok', false, 'motivo', 'eleicao_inexistente');
  end if;

  select * into v_eleitor
  from cipa_eleitores
  where eleicao_id = e.id and regexp_replace(matricula, '^0+', '') = v_mat;

  if not found or v_eleitor.cpf_hash is null
     or length(v_cpf) <> 11 or v_eleitor.cpf_hash <> crypt(v_cpf, v_eleitor.cpf_hash) then
    return jsonb_build_object('ok', false, 'motivo', 'nao_encontrado');
  end if;

  select protocolo, votou_em into v_prot, v_quando
  from cipa_votantes where eleicao_id = e.id and eleitor_id = v_eleitor.id;

  return jsonb_build_object(
    'ok', true,
    'votou', v_prot is not null,
    'protocolo', v_prot,
    'votou_em', v_quando,
    'eleitor', v_eleitor.nome
  );
end;
$$;

-- ------------------------------------------------------------ comissão eleitoral

create or replace function cipa_e_comissao()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from cipa_comissao where email = lower(auth.jwt() ->> 'email')
  );
$$;

-- Acompanhamento ao vivo: só quórum, nunca contagem de votos (NR-5 5.5.4).
create or replace function cipa_painel(p_slug text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  e        cipa_eleicoes%rowtype;
  v_aptos  int;
  v_vot    int;
begin
  if not cipa_e_comissao() then
    raise exception 'acesso negado' using errcode = '42501';
  end if;

  select * into e from cipa_eleicoes where slug = p_slug;
  if not found then
    return jsonb_build_object('ok', false, 'motivo', 'eleicao_inexistente');
  end if;

  select count(*) into v_aptos from cipa_eleitores where eleicao_id = e.id and apto;
  select count(*) into v_vot   from cipa_votantes  where eleicao_id = e.id;

  return jsonb_build_object(
    'ok', true,
    'nome', e.nome,
    'aberta', now() between e.abertura and e.encerramento,
    'encerramento', e.encerramento,
    'aptos', v_aptos,
    'votantes', v_vot,
    'percentual', case when v_aptos = 0 then 0
                       else round(v_vot::numeric * 100 / v_aptos, 1) end,
    'atingiu_metade', v_aptos > 0 and v_vot::numeric / v_aptos >= 0.5,
    'atingiu_um_terco', v_aptos > 0 and v_vot::numeric / v_aptos >= (1.0/3.0),
    'resultado_publicado', e.resultado_publicado
  );
end;
$$;

-- Apuração. Só depois de a comissão liberar (ato formal, NR-5 5.5.3-i).
-- Traz TODOS os candidatos em ordem decrescente, inclusive não eleitos (NR-5 5.5.8).
create or replace function cipa_apuracao(p_slug text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  e cipa_eleicoes%rowtype;
begin
  if not cipa_e_comissao() then
    raise exception 'acesso negado' using errcode = '42501';
  end if;

  select * into e from cipa_eleicoes where slug = p_slug;
  if not found then
    return jsonb_build_object('ok', false, 'motivo', 'eleicao_inexistente');
  end if;
  if not e.resultado_publicado then
    return jsonb_build_object('ok', false, 'motivo', 'apuracao_nao_liberada');
  end if;

  return jsonb_build_object(
    'ok', true,
    'nome', e.nome,
    'vagas_efetivos', e.vagas_efetivos,
    'vagas_suplentes', e.vagas_suplentes,
    'total_votantes', (select count(*) from cipa_votantes where eleicao_id = e.id),
    'aptos', (select count(*) from cipa_eleitores where eleicao_id = e.id and apto),
    'brancos', (select count(*) from cipa_votos where eleicao_id = e.id and candidato_id is null),
    'por_dia', coalesce((
      select jsonb_agg(jsonb_build_object('dia', d.dia, 'votos', d.n) order by d.dia)
      from (select dia, count(*) n from cipa_votos where eleicao_id = e.id group by dia) d
    ), '[]'::jsonb),
    'resultado', coalesce((
      select jsonb_agg(jsonb_build_object(
               'numero', c.numero, 'nome', c.nome, 'setor', c.setor, 'votos', v.n)
               order by v.n desc, c.nome)
      from cipa_candidatos c
      join lateral (
        select count(*) n from cipa_votos vo
        where vo.eleicao_id = e.id and vo.candidato_id = c.id
      ) v on true
      where c.eleicao_id = e.id
    ), '[]'::jsonb)
  );
end;
$$;

-- Lista de presença nominal — a prova de quem participou (e do quórum).
create or replace function cipa_lista_votantes(p_slug text)
returns table (nome text, matricula text, setor text, votou_em timestamptz, protocolo text)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not cipa_e_comissao() then
    raise exception 'acesso negado' using errcode = '42501';
  end if;

  return query
  select el.nome, el.matricula, el.setor, vt.votou_em, vt.protocolo
  from cipa_votantes vt
  join cipa_eleitores el on el.id = vt.eleitor_id
  join cipa_eleicoes e   on e.id = vt.eleicao_id
  where e.slug = p_slug
  order by vt.votou_em;
end;
$$;

grant execute on function cipa_eleicao_publica(text) to anon, authenticated;
grant execute on function cipa_votar(text, text, text, uuid[]) to anon, authenticated;
grant execute on function cipa_comprovante(text, text, text) to anon, authenticated;
grant execute on function cipa_painel(text) to authenticated;
grant execute on function cipa_apuracao(text) to authenticated;
grant execute on function cipa_lista_votantes(text) to authenticated;
