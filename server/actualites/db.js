// Tables du module « Actualités chrétiennes » — créées automatiquement au démarrage (aucune action manuelle sur la base).
const pool = require('../db/pool');

const CATEGORIES = [
  ['eglise', 'Église dans le monde'],
  ['persecution', 'Liberté religieuse et persécutions'],
  ['mission', 'Missions et évangélisation'],
  ['solidarite', 'Solidarité et humanitaire'],
  ['evenement', 'Événements et rassemblements'],
  ['societe', 'Société et culture'],
  ['jeunesse', 'Jeunesse et famille'],
  ['temoignage', 'Témoignages'],
  ['annonce', 'Annonces du ministère'],
];

const REGIONS = ['Afrique', 'Europe', 'Amérique du Nord', 'Amérique latine', 'Asie', 'Moyen-Orient', 'Océanie', 'Monde'];

// Sources officielles proposées au départ. Si l'adresse du flux n'est pas indiquée, le site la détecte tout seul.
// L'administrateur peut ajouter, retirer ou désactiver des sources depuis l'espace d'administration.
const DEFAULT_SOURCES = [
  { name: 'Vatican News (français)', site_url: 'https://www.vaticannews.va/fr.html', feed_url: 'https://www.vaticannews.va/fr.rss.xml', language: 'fr', region: 'Monde', category: 'eglise' },
  { name: 'Vatican News (English)', site_url: 'https://www.vaticannews.va/en.html', feed_url: 'https://www.vaticannews.va/en.rss.xml', language: 'en', region: 'Monde', category: 'eglise' },
  { name: 'Conseil œcuménique des Églises', site_url: 'https://www.oikoumene.org', feed_url: null, language: 'en', region: 'Monde', category: 'eglise' },
  { name: 'Anglican Communion News Service', site_url: 'https://www.anglicannews.org', feed_url: null, language: 'en', region: 'Monde', category: 'eglise' },
  { name: 'Evangelical Focus (Europe)', site_url: 'https://evangelicalfocus.com', feed_url: null, language: 'en', region: 'Europe', category: 'eglise' },
  { name: 'Christianity Today', site_url: 'https://www.christianitytoday.com', feed_url: null, language: 'en', region: 'Amérique du Nord', category: 'eglise' },
  { name: 'Baptist Press', site_url: 'https://www.baptistpress.com', feed_url: null, language: 'en', region: 'Amérique du Nord', category: 'mission' },
  { name: 'Open Doors', site_url: 'https://www.opendoors.org', feed_url: null, language: 'en', region: 'Monde', category: 'persecution' },
];

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS news_articles (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      summary TEXT,
      body_html TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT 'eglise',
      region TEXT,
      country TEXT,
      language TEXT NOT NULL DEFAULT 'fr',
      cover_url TEXT,
      source_name TEXT,
      source_url TEXT,
      author TEXT,
      published_at TIMESTAMPTZ,
      contacts JSONB NOT NULL DEFAULT '[]',
      tags TEXT[] NOT NULL DEFAULT '{}',
      video_url TEXT,
      status TEXT NOT NULL DEFAULT 'publie' CHECK (status IN ('brouillon', 'publie')),
      featured BOOLEAN NOT NULL DEFAULT false,
      origin TEXT NOT NULL DEFAULT 'manuel' CHECK (origin IN ('manuel', 'lien', 'suggestion')),
      views INTEGER NOT NULL DEFAULT 0,
      created_by INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS news_articles_status_date_idx ON news_articles (status, created_at DESC);
    CREATE INDEX IF NOT EXISTS news_articles_source_url_idx ON news_articles (source_url);

    CREATE TABLE IF NOT EXISTS news_images (
      id SERIAL PRIMARY KEY,
      article_id INTEGER NOT NULL REFERENCES news_articles(id) ON DELETE CASCADE,
      mime TEXT NOT NULL,
      data BYTEA NOT NULL,
      caption TEXT,
      is_cover BOOLEAN NOT NULL DEFAULT false,
      position INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS news_images_article_idx ON news_images (article_id);

    CREATE TABLE IF NOT EXISTS news_sources (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      site_url TEXT NOT NULL,
      feed_url TEXT,
      language TEXT NOT NULL DEFAULT 'fr',
      region TEXT,
      category TEXT NOT NULL DEFAULT 'eglise',
      enabled BOOLEAN NOT NULL DEFAULT true,
      last_checked_at TIMESTAMPTZ,
      last_status TEXT,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS news_suggestions (
      id SERIAL PRIMARY KEY,
      source_id INTEGER REFERENCES news_sources(id) ON DELETE SET NULL,
      source_name TEXT,
      title TEXT NOT NULL,
      summary TEXT,
      link TEXT NOT NULL UNIQUE,
      image_url TEXT,
      published_at TIMESTAMPTZ,
      language TEXT NOT NULL DEFAULT 'fr',
      region TEXT,
      category TEXT NOT NULL DEFAULT 'eglise',
      status TEXT NOT NULL DEFAULT 'nouvelle' CHECK (status IN ('nouvelle', 'validee', 'rejetee', 'expiree')),
      article_id INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS news_suggestions_status_idx ON news_suggestions (status, created_at DESC);

    CREATE TABLE IF NOT EXISTS news_meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  const { rows } = await pool.query('SELECT count(*)::int AS n FROM news_sources');
  if (rows[0].n === 0) {
    for (const s of DEFAULT_SOURCES) {
      await pool.query(
        'INSERT INTO news_sources (name, site_url, feed_url, language, region, category) VALUES ($1,$2,$3,$4,$5,$6)',
        [s.name, s.site_url, s.feed_url, s.language, s.region, s.category]
      );
    }
  }
}

module.exports = { ensureSchema, CATEGORIES, REGIONS };
