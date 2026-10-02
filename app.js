begin;

create or replace function public.app_update_profile(
  p_token text,
  p_alias text default null,
  p_discord text default null,
  p_current_account_id text default null,
  p_purchased_items jsonb default null,
  p_discord_numeric_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid text;
  v_type text;
  v_current_num text;
  v_fallback text;
begin
  v_uid := public.app_user_from_token(p_token);

  if p_alias is not null and (length(btrim(p_alias)) not between 1 and 20 or p_alias ~ '[<>"''`\\]|[[:cntrl:]]') then
    raise exception 'invalid_alias';
  end if;
  if p_discord is not null and (length(btrim(p_discord)) not between 1 and 64 or p_discord ~ '[<>"''`\\]|[[:cntrl:]]') then
    raise exception 'invalid_discord';
  end if;
  if p_current_account_id is not null
     and not exists (select 1 from public.accounts where id = p_current_account_id and user_id = v_uid) then
    select a.id into v_fallback
      from public.accounts a
     where a.user_id = v_uid
     order by a.sort_order nulls last, a.created_at
     limit 1;
    p_current_account_id := v_fallback;
  end if;

  update public.users
     set alias = coalesce(btrim(p_alias), alias),
         discord = coalesce(btrim(p_discord), discord),
         current_account_id = coalesce(p_current_account_id, current_account_id)
   where id = v_uid;

  if p_discord_numeric_id is not null and p_discord_numeric_id <> '' then
    select nullif(discord_numeric_id::text, '') into v_current_num from public.users where id = v_uid;
    if v_current_num is distinct from p_discord_numeric_id then
      if public.app_auth_discord_id() is distinct from p_discord_numeric_id then
        raise exception 'discord_mismatch';
      end if;
      execute format('update public.users set discord_numeric_id = %L where id = %L', p_discord_numeric_id, v_uid);
    end if;
  end if;

  if p_purchased_items is not null then
    select data_type into v_type
      from information_schema.columns
     where table_schema = 'public' and table_name = 'users' and column_name = 'purchased_items';

    if v_type = 'ARRAY' then
      update public.users
         set purchased_items = array(select jsonb_array_elements_text(p_purchased_items))
       where id = v_uid;
    elsif v_type in ('jsonb', 'json') then
      update public.users set purchased_items = p_purchased_items where id = v_uid;
    elsif v_type is not null then
      update public.users set purchased_items = p_purchased_items::text where id = v_uid;
    end if;
  end if;

  return jsonb_build_object('ok', true);
end;
$$;

commit;
