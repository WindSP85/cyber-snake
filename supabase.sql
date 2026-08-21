-- ============================================================
-- Глобальная таблица лидеров NEON://SNAKE (Supabase) — feature T14
--
-- Как подключить облако:
--   1. Создать проект на https://supabase.com (бесплатный тариф хватит).
--   2. Открыть SQL Editor → вставить этот файл целиком → Run.
--   3. Project Settings → API: скопировать Project URL и anon public key.
--   4. Вписать их в js/config.js (supabaseUrl и supabaseKey).
-- После этого игра сама переключится на мировую таблицу лидеров;
-- пока js/config.js пуст — игра остаётся полностью локальной (localStorage).
--
-- Безопасность: ключ anon публичный, это нормально. RLS разрешает
-- только SELECT и INSERT; менять и удалять чужие рекорды извне нельзя,
-- а CHECK-ограничения не дают вставить мусор (пустое имя, отрицательный
-- счёт и т.п.).
-- ============================================================

-- Сама таблица рекордов
create table if not exists scores (
  id bigint generated always as identity primary key,
  created_at timestamptz default now() not null,
  name text not null check (char_length(trim(name)) between 1 and 12),
  score integer not null check (score >= 0 and score <= 1000000),
  level integer not null default 1 check (level >= 1 and level <= 999)
);

-- Row Level Security: все дальнейшие правила ниже
alter table scores enable row level security;

-- читать может кто угодно с anon-ключом
create policy "public read" on scores for select using (true);

-- добавлять может кто угодно (anon), но только валидные строки (CHECK выше)
create policy "public insert" on scores for insert with check (true);

-- НИКАКИХ update/delete политик: менять и удалять рекорды извне нельзя

-- Индекс топа: выборка топ-10 по убыванию счёта
create index if not exists scores_score_desc on scores (score desc);
