-- ВидеоКласс: база данных, безопасные правила и хранилище видео.
-- Выполните весь файл в SQL Editor вашего проекта Supabase.

create extension if not exists pgcrypto;

create table if not exists public.teachers (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.videos (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 1 and 150),
  description text check (description is null or char_length(description) <= 500),
  storage_path text not null unique,
  duration_seconds numeric,
  published boolean not null default true,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists public.watch_sessions (
  id uuid primary key default gen_random_uuid(),
  video_id uuid not null references public.videos(id) on delete cascade,
  student_name text not null check (char_length(student_name) between 3 and 100),
  student_class text not null check (char_length(student_class) between 1 and 20),
  client_token uuid not null,
  started_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  completed_at timestamptz,
  duration_seconds numeric not null default 0,
  active_seconds numeric not null default 0,
  coverage_seconds numeric not null default 0,
  max_position numeric not null default 0,
  percent numeric not null default 0 check (percent between 0 and 100),
  max_rate numeric not null default 1,
  seek_count integer not null default 0,
  pause_count integer not null default 0,
  status text not null default 'started' check (status in ('started', 'partial', 'fast', 'completed')),
  watched_ranges jsonb not null default '[]'::jsonb
);

create index if not exists watch_sessions_video_id_idx on public.watch_sessions(video_id);
create index if not exists watch_sessions_last_seen_idx on public.watch_sessions(last_seen_at desc);

alter table public.teachers enable row level security;
alter table public.videos enable row level security;
alter table public.watch_sessions enable row level security;

create or replace function public.is_teacher()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists(select 1 from public.teachers where user_id = auth.uid());
$$;

revoke all on function public.is_teacher() from public;
grant execute on function public.is_teacher() to anon, authenticated;

drop policy if exists "Teacher reads own membership" on public.teachers;
create policy "Teacher reads own membership"
on public.teachers for select
to authenticated
using (user_id = auth.uid());

drop policy if exists "Published videos are visible" on public.videos;
create policy "Published videos are visible"
on public.videos for select
to anon, authenticated
using (published or public.is_teacher());

drop policy if exists "Teachers create videos" on public.videos;
create policy "Teachers create videos"
on public.videos for insert
to authenticated
with check (public.is_teacher() and created_by = auth.uid());

drop policy if exists "Teachers update videos" on public.videos;
create policy "Teachers update videos"
on public.videos for update
to authenticated
using (public.is_teacher())
with check (public.is_teacher());

drop policy if exists "Teachers delete videos" on public.videos;
create policy "Teachers delete videos"
on public.videos for delete
to authenticated
using (public.is_teacher());

drop policy if exists "Teachers read viewing results" on public.watch_sessions;
create policy "Teachers read viewing results"
on public.watch_sessions for select
to authenticated
using (public.is_teacher());

revoke all on table public.teachers from anon, authenticated;
revoke all on table public.videos from anon, authenticated;
revoke all on table public.watch_sessions from anon, authenticated;
grant select on table public.teachers to authenticated;
grant select on table public.videos to anon, authenticated;
grant insert, update, delete on table public.videos to authenticated;
grant select on table public.watch_sessions to authenticated;

-- Ученик создаёт запись только для опубликованного видео. Таблица напрямую ему недоступна.
create or replace function public.start_watch(
  p_video_id uuid,
  p_student_name text,
  p_student_class text,
  p_client_token uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_id uuid;
  clean_name text := trim(regexp_replace(coalesce(p_student_name, ''), '\s+', ' ', 'g'));
  clean_class text := upper(trim(regexp_replace(coalesce(p_student_class, ''), '\s+', ' ', 'g')));
begin
  if p_client_token is null then
    raise exception 'Client token is required';
  end if;
  if char_length(clean_name) not between 3 and 100 then
    raise exception 'Invalid student name';
  end if;
  if char_length(clean_class) not between 1 and 20 then
    raise exception 'Invalid class';
  end if;
  if not exists(select 1 from public.videos where id = p_video_id and published = true) then
    raise exception 'Video is not available';
  end if;

  insert into public.watch_sessions(video_id, student_name, student_class, client_token)
  values (p_video_id, clean_name, clean_class, p_client_token)
  returning id into new_id;
  return new_id;
end;
$$;

-- Прогресс можно обновить только при наличии секретного токена конкретной сессии.
create or replace function public.update_watch(
  p_session_id uuid,
  p_client_token uuid,
  p_duration_seconds numeric,
  p_active_seconds numeric,
  p_coverage_seconds numeric,
  p_max_position numeric,
  p_percent numeric,
  p_max_rate numeric,
  p_seek_count integer,
  p_pause_count integer,
  p_status text,
  p_watched_ranges jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  current_row public.watch_sessions%rowtype;
  next_duration numeric;
  next_active numeric;
  next_coverage numeric;
  next_percent numeric;
  next_rate numeric;
  next_status text;
begin
  select * into current_row
  from public.watch_sessions
  where id = p_session_id and client_token = p_client_token
  for update;

  if not found then
    raise exception 'Viewing session not found';
  end if;

  next_duration := greatest(current_row.duration_seconds, least(greatest(coalesce(p_duration_seconds, 0), 0), 86400));
  next_active := greatest(current_row.active_seconds, least(greatest(coalesce(p_active_seconds, 0), 0), 86400));
  next_coverage := greatest(current_row.coverage_seconds, least(greatest(coalesce(p_coverage_seconds, 0), 0), next_duration));
  next_percent := case when next_duration > 0 then least(100, round((next_coverage / next_duration) * 100, 1)) else 0 end;
  next_rate := greatest(current_row.max_rate, least(greatest(coalesce(p_max_rate, 1), 0.25), 16));

  next_status := case
    when next_percent >= 90 then 'completed'
    when next_rate > 1.25 or (next_coverage > 30 and next_active / nullif(next_coverage, 0) < 0.78) then 'fast'
    when next_percent >= 10 then 'partial'
    else 'started'
  end;

  update public.watch_sessions
  set
    last_seen_at = now(),
    completed_at = case when next_status = 'completed' then coalesce(completed_at, now()) else completed_at end,
    duration_seconds = next_duration,
    active_seconds = next_active,
    coverage_seconds = next_coverage,
    max_position = greatest(current_row.max_position, least(greatest(coalesce(p_max_position, 0), 0), next_duration)),
    percent = next_percent,
    max_rate = next_rate,
    seek_count = greatest(current_row.seek_count, least(greatest(coalesce(p_seek_count, 0), 0), 100000)),
    pause_count = greatest(current_row.pause_count, least(greatest(coalesce(p_pause_count, 0), 0), 100000)),
    status = next_status,
    watched_ranges = case
      when jsonb_typeof(p_watched_ranges) = 'array' and pg_column_size(p_watched_ranges) <= 50000 then p_watched_ranges
      else current_row.watched_ranges
    end
  where id = p_session_id;
end;
$$;

revoke all on function public.start_watch(uuid, text, text, uuid) from public;
revoke all on function public.update_watch(uuid, uuid, numeric, numeric, numeric, numeric, numeric, numeric, integer, integer, text, jsonb) from public;
grant execute on function public.start_watch(uuid, text, text, uuid) to anon, authenticated;
grant execute on function public.update_watch(uuid, uuid, numeric, numeric, numeric, numeric, numeric, numeric, integer, integer, text, jsonb) to anon, authenticated;

-- Закрытое хранилище. Опубликованные файлы ученики получают по временной ссылке.
insert into storage.buckets (id, name, public)
values ('lesson-videos', 'lesson-videos', false)
on conflict (id) do update set public = false;

drop policy if exists "Teachers upload lesson videos" on storage.objects;
create policy "Teachers upload lesson videos"
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'lesson-videos'
  and public.is_teacher()
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists "Teachers manage lesson videos" on storage.objects;
create policy "Teachers manage lesson videos"
on storage.objects for update
to authenticated
using (bucket_id = 'lesson-videos' and public.is_teacher())
with check (bucket_id = 'lesson-videos' and public.is_teacher());

drop policy if exists "Teachers delete lesson videos" on storage.objects;
create policy "Teachers delete lesson videos"
on storage.objects for delete
to authenticated
using (bucket_id = 'lesson-videos' and public.is_teacher());

drop policy if exists "Published lesson videos can be viewed" on storage.objects;
create policy "Published lesson videos can be viewed"
on storage.objects for select
to anon, authenticated
using (
  bucket_id = 'lesson-videos'
  and (
    public.is_teacher()
    or exists (
      select 1 from public.videos
      where videos.storage_path = storage.objects.name and videos.published = true
    )
  )
);

-- ПОСЛЕ создания учителя в Authentication > Users выполните отдельно:
-- insert into public.teachers(user_id) values ('UUID_УЧИТЕЛЯ');
