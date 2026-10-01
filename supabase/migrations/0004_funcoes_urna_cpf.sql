-- Funções da urna no fluxo "login só por CPF".
--
-- Nota de estado: a versão antiga de cipa_votar (com p_matricula) NÃO pôde ser removida —
-- `drop function` é bloqueado pela proteção de DDL destrutivo deste ambiente. Em vez disso ela
-- ficou sem permissão de execução para anon/authenticated (ver 0003). As duas coexistem como
-- sobrecarga; o cliente chama sempre por argumentos nomeados, então só a nova é alcançável.
--
-- Rollback: drop function cipa_identificar(text,text), cipa_votar(text,text,uuid[]);

-- Uma única chamada devolve identidade + estado + cédula. No tablet do chão de fábrica, cada
-- ida e volta a mais é uma chance de a pessoa achar que travou e tocar o botão de novo.
create or replace function cipa_identificar(p_slug text, p_cpf text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  e        cipa_eleicoes%rowtype;
  v_el     cipa_eleitores%rowtype;
  v_cpf    text := regexp_replace(coalesce(p_cpf,''), '\D', '', 'g');
  v_hmac   text;
  v_ip     inet;
  v_prot   text;
  v_quando timestamptz;
begin
  select * into e from cipa_eleicoes where slug = p_slug;
  if not found then
    return jsonb_build_object('ok', false, 'motivo', 'eleicao_inexistente');
  end if;
  if now() < e.abertura then
    return jsonb_build_object('ok', false, 'motivo', 'nao_comecou', 'abertura', e.abertura);
  end if;
  if now() > e.encerramento then
    return jsonb_build_object('ok', false, 'motivo', 'encerrada', 'encerramento', e.encerramento);
  end if;

  -- Erro de digitação não é ataque: não grava tentativa, para não entupir o limite.
  if not cipa_cpf_valido(v_cpf) then
    return jsonb_build_object('ok', false, 'motivo', 'cpf_invalido');
  end if;

  begin
    v_ip := nullif(split_part(
              coalesce(current_setting('request.headers', true)::json ->> 'x-forwarded-for',''),
              ',', 1), '')::inet;
  exception when others then v_ip := null;
  end;

  v_hmac := cipa_cpf_hmac(v_cpf);

  if cipa_bloqueado(e.id, v_ip, v_hmac) then
    return jsonb_build_object('ok', false, 'motivo', 'muitas_tentativas');
  end if;

  select * into v_el from cipa_eleitores where eleicao_id = e.id and cpf_hmac = v_hmac;

  if not found then
    insert into cipa_tentativas (eleicao_id, ip, cpf_hmac, sucesso) values (e.id, v_ip, v_hmac, false);
    return jsonb_build_object('ok', false, 'motivo', 'nao_encontrado');
  end if;

  insert into cipa_tentativas (eleicao_id, ip, cpf_hmac, sucesso) values (e.id, v_ip, v_hmac, true);

  if not v_el.apto then
    return jsonb_build_object('ok', false, 'motivo', 'nao_apto', 'nome', v_el.nome);
  end if;

  select protocolo, votou_em into v_prot, v_quando
    from cipa_votantes where eleicao_id = e.id and eleitor_id = v_el.id;

  return jsonb_build_object(
    'ok', true,
    'nome', v_el.nome,
    'setor', v_el.setor,
    'ja_votou', v_prot is not null,
    'protocolo', v_prot,
    'votou_em', v_quando,
    'eleicao', jsonb_build_object(
      'nome', e.nome,
      'estabelecimento', e.estabelecimento,
      'encerramento', e.encerramento,
      'votos_por_eleitor', e.votos_por_eleitor,
      'permite_branco', e.permite_branco),
    'candidatos', coalesce((
      select jsonb_agg(jsonb_build_object('id', c.id, 'numero', c.numero,
                                          'nome', c.nome, 'setor', c.setor)
             order by c.ordem, c.numero, c.nome)
      from cipa_candidatos c where c.eleicao_id = e.id and c.ativo), '[]'::jsonb)
  );
end;
$$;

-- Registra o voto. Presença e voto entram na mesma transação, em tabelas sem vínculo.
create or replace function cipa_votar(p_slug text, p_cpf text, p_candidatos uuid[])
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  e           cipa_eleicoes%rowtype;
  v_el        cipa_eleitores%rowtype;
  v_cpf       text := regexp_replace(coalesce(p_cpf,''), '\D', '', 'g');
  v_hmac      text;
  v_protocolo text;
  v_quando    timestamptz;
  v_cand      uuid;
  v_ip        inet;
  v_ua        text;
begin
  select * into e from cipa_eleicoes where slug = p_slug;
  if not found then return jsonb_build_object('ok', false, 'motivo', 'eleicao_inexistente'); end if;
  if now() < e.abertura     then return jsonb_build_object('ok', false, 'motivo', 'nao_comecou'); end if;
  if now() > e.encerramento then return jsonb_build_object('ok', false, 'motivo', 'encerrada');   end if;

  if not cipa_cpf_valido(v_cpf) then
    return jsonb_build_object('ok', false, 'motivo', 'cpf_invalido');
  end if;

  begin
    v_ip := nullif(split_part(
              coalesce(current_setting('request.headers', true)::json ->> 'x-forwarded-for',''),
              ',', 1), '')::inet;
    v_ua := current_setting('request.headers', true)::json ->> 'user-agent';
  exception when others then v_ip := null; v_ua := null;
  end;

  v_hmac := cipa_cpf_hmac(v_cpf);
  if cipa_bloqueado(e.id, v_ip, v_hmac) then
    return jsonb_build_object('ok', false, 'motivo', 'muitas_tentativas');
  end if;

  select * into v_el from cipa_eleitores where eleicao_id = e.id and cpf_hmac = v_hmac;
  if not found then
    insert into cipa_tentativas (eleicao_id, ip, cpf_hmac, sucesso) values (e.id, v_ip, v_hmac, false);
    return jsonb_build_object('ok', false, 'motivo', 'nao_encontrado');
  end if;
  if not v_el.apto then return jsonb_build_object('ok', false, 'motivo', 'nao_apto'); end if;

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
    if exists (select 1 from unnest(p_candidatos) x
               where not exists (select 1 from cipa_candidatos c
                                 where c.id = x and c.eleicao_id = e.id and c.ativo)) then
      return jsonb_build_object('ok', false, 'motivo', 'candidato_invalido');
    end if;
  end if;

  v_protocolo := upper(encode(extensions.gen_random_bytes(5), 'hex'));

  -- O UNIQUE(eleicao_id, eleitor_id) é o que impede o voto duplo: duas abas, duplo toque ou
  -- retry de rede caem aqui e recebem de volta o comprovante original.
  begin
    insert into cipa_votantes (eleicao_id, eleitor_id, protocolo, ip, user_agent)
    values (e.id, v_el.id, v_protocolo, v_ip, v_ua)
    returning votou_em into v_quando;
  exception when unique_violation then
    select protocolo, votou_em into v_protocolo, v_quando
      from cipa_votantes where eleicao_id = e.id and eleitor_id = v_el.id;
    return jsonb_build_object('ok', false, 'motivo', 'ja_votou',
                              'protocolo', v_protocolo, 'votou_em', v_quando);
  end;

  -- Urna. Nada aqui aponta para v_el. Só a DATA, nunca a hora.
  if p_candidatos is null or array_length(p_candidatos, 1) is null then
    insert into cipa_votos (eleicao_id, candidato_id) values (e.id, null);
  else
    foreach v_cand in array p_candidatos loop
      insert into cipa_votos (eleicao_id, candidato_id) values (e.id, v_cand);
    end loop;
  end if;

  -- votou_em vem de cipa_votantes (a presença), que já existia e é legítimo registrar.
  -- Nenhuma hora foi adicionada a cipa_votos.
  return jsonb_build_object('ok', true, 'protocolo', v_protocolo,
                            'votou_em', v_quando, 'nome', v_el.nome);
end;
$$;

grant execute on function cipa_identificar(text, text)   to anon, authenticated;
grant execute on function cipa_votar(text, text, uuid[]) to anon, authenticated;
