-- 14단계: 이체 중복 요청 방지 (멱등성)
-- 같은 p_request_id로 재요청하면 이체를 다시 하지 않고 처음 결과를 돌려줍니다.
-- 순서: 이 SQL 먼저 실행 -> 그 다음 app.js 배포
begin;

create table if not exists public.app_idempotency (
  user_id    text not null,
  request_id text not null,
  result     jsonb not null,
  created_at timestamptz not null default now(),
  primary key (user_id, request_id)
);
create index if not exists app_idempotency_created_idx on public.app_idempotency (created_at);
alter table public.app_idempotency enable row level security;
revoke all on public.app_idempotency from public, anon, authenticated;

-- 기존 app_transfer 본체를 내부용으로 이름만 변경 (로직은 그대로)
alter function public.app_transfer(text, text, text, bigint, text, text, text)
  rename to app_transfer_core;
revoke execute on function public.app_transfer_core(text, text, text, bigint, text, text, text)
  from public, anon, authenticated;

create or replace function public.app_transfer(
  p_token text,
  p_from_account text,
  p_to_account text,
  p_amount bigint,
  p_memo text default null::text,
  p_label text default 'transfer'::text,
  p_date_label text default '방금 전'::text,
  p_request_id text default null::text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid text;
  v_res jsonb;
begin
  v_uid := public.app_user_from_token(p_token);

  if p_request_id is not null then
    if length(p_request_id) > 100 then
      return jsonb_build_array(jsonb_build_object('ok', false, 'reason', 'invalid_request_id'));
    end if;

    -- 같은 요청이 동시에 두 번 들어와도 순서대로 처리
    perform pg_advisory_xact_lock(hashtextextended(v_uid || ':' || p_request_id, 0));

    select i.result into v_res
      from public.app_idempotency i
     where i.user_id = v_uid and i.request_id = p_request_id;
    if found then
      return v_res;
    end if;

    delete from public.app_idempotency where created_at < now() - interval '1 day';
  end if;

  v_res := public.app_transfer_core(
    p_token, p_from_account, p_to_account, p_amount, p_memo, p_label, p_date_label
  );

  -- 성공한 이체만 기록 (실패는 재시도 가능)
  if p_request_id is not null and coalesce(v_res -> 0 ->> 'ok', 'false') = 'true' then
    insert into public.app_idempotency (user_id, request_id, result)
    values (v_uid, p_request_id, v_res)
    on conflict do nothing;
  end if;

  return v_res;
end;
$$;

revoke execute on function public.app_transfer(text, text, text, bigint, text, text, text, text) from public;
grant execute on function public.app_transfer(text, text, text, bigint, text, text, text, text) to anon, authenticated;

commit;
