-- Grande Bibliothèque numérique MNA — schéma de base de données
-- À exécuter une fois sur la base PostgreSQL (via le Shell Render ou un client SQL)

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  full_name TEXT,
  role TEXT NOT NULL DEFAULT 'lecteur' CHECK (role IN ('lecteur', 'admin')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Un livre du catalogue général (lecture en ligne / téléchargeable / à vendre)
-- ou un livre de l'espace d'étude (is_study_book = true, avec order_index pour la séquence de déverrouillage)
CREATE TABLE IF NOT EXISTS books (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  author TEXT,
  description TEXT,
  cover_url TEXT,
  source_format TEXT CHECK (source_format IN ('pdf', 'word')),
  access_type TEXT NOT NULL DEFAULT 'lecture_en_ligne'
    CHECK (access_type IN ('lecture_en_ligne', 'telechargeable', 'a_vendre')),
  price NUMERIC(10,2),
  has_audio BOOLEAN NOT NULL DEFAULT false,
  audio_url TEXT,
  is_study_book BOOLEAN NOT NULL DEFAULT false,
  order_index INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Parties d'un livre de l'espace d'étude (déverrouillage progressif)
CREATE TABLE IF NOT EXISTS book_parts (
  id SERIAL PRIMARY KEY,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  part_index INTEGER NOT NULL,
  title TEXT,
  content TEXT,
  UNIQUE (book_id, part_index)
);

-- Questions de test : liées à une partie (petit test) ou au livre entier avec part_id NULL (grand test)
CREATE TABLE IF NOT EXISTS quiz_questions (
  id SERIAL PRIMARY KEY,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  part_id INTEGER REFERENCES book_parts(id) ON DELETE CASCADE,
  question_text TEXT NOT NULL,
  choices JSONB NOT NULL,
  correct_choice_index INTEGER NOT NULL
);

-- Progression d'un lecteur sur un livre de l'espace d'étude
CREATE TABLE IF NOT EXISTS user_progress (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  unlocked BOOLEAN NOT NULL DEFAULT false,
  current_part_index INTEGER NOT NULL DEFAULT 1,
  grand_test_passed BOOLEAN NOT NULL DEFAULT false,
  certificate_issued BOOLEAN NOT NULL DEFAULT false,
  unlocked_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  UNIQUE (user_id, book_id)
);

-- Résultat d'un test (petit test de partie ou grand test de livre)
CREATE TABLE IF NOT EXISTS quiz_attempts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  part_id INTEGER REFERENCES book_parts(id) ON DELETE CASCADE,
  passed BOOLEAN NOT NULL,
  score NUMERIC(5,2),
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Messages envoyés par les lecteurs au ministère
CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject TEXT,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'recu' CHECK (status IN ('recu', 'repondu')),
  reply_body TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  replied_at TIMESTAMPTZ
);

-- Achats manuels (mobile money / WhatsApp)
CREATE TABLE IF NOT EXISTS purchases (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'en_attente' CHECK (status IN ('en_attente', 'confirme', 'refuse')),
  reference_paiement TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at TIMESTAMPTZ
);
