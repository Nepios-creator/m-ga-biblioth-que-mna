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
  ['buzz', 'Buzz et débats'],
  ['annonce', 'Annonces du ministère'],
];

const REGIONS = ['Afrique', 'Europe', 'Amérique du Nord', 'Amérique latine', 'Asie', 'Moyen-Orient', 'Océanie', 'Monde'];

// Sources proposées au départ : uniquement des sites en français, de toutes les sensibilités chrétiennes
// (protestants, évangéliques, œcuméniques, catholiques). Si l'adresse du flux n'est pas indiquée, le site la détecte tout seul.
// L'administrateur peut ajouter, retirer ou désactiver des sources depuis l'espace d'administration.
const DEFAULT_SOURCES = [
  { name: 'Réforme (protestant)', site_url: 'https://www.reforme.net', feed_url: null, language: 'fr', region: 'Europe', category: 'eglise' },
  { name: 'Protestinfo (Suisse)', site_url: 'https://www.protestinfo.ch', feed_url: null, language: 'fr', region: 'Europe', category: 'eglise' },
  { name: 'Fédération protestante de France', site_url: 'https://www.protestants.org', feed_url: null, language: 'fr', region: 'Europe', category: 'eglise' },
  { name: 'Christianisme Aujourd\'hui (évangélique)', site_url: 'https://www.christianismeaujourdhui.info', feed_url: null, language: 'fr', region: 'Monde', category: 'eglise' },
  { name: 'Top Chrétien', site_url: 'https://www.topchretien.com', feed_url: null, language: 'fr', region: 'Monde', category: 'buzz' },
  { name: 'Journal Chrétien', site_url: 'https://www.journalchretien.net', feed_url: null, language: 'fr', region: 'Monde', category: 'eglise' },
  { name: 'Évangéliques de France (CNEF)', site_url: 'https://www.lecnef.org', feed_url: null, language: 'fr', region: 'Europe', category: 'eglise' },
  { name: 'Jesus.ch (Suisse)', site_url: 'https://www.jesus.ch', feed_url: null, language: 'fr', region: 'Europe', category: 'eglise' },
  { name: 'Portes Ouvertes France', site_url: 'https://www.portesouvertes.fr', feed_url: null, language: 'fr', region: 'Monde', category: 'persecution' },
  { name: 'Croire.com (toutes confessions)', site_url: 'https://www.croire.com', feed_url: null, language: 'fr', region: 'Monde', category: 'societe' },
  { name: 'Aleteia (français)', site_url: 'https://fr.aleteia.org', feed_url: null, language: 'fr', region: 'Monde', category: 'buzz' },
  { name: 'Vatican News (français)', site_url: 'https://www.vaticannews.va/fr.html', feed_url: 'https://www.vaticannews.va/fr.rss.xml', language: 'fr', region: 'Monde', category: 'eglise' },
];

// Anciennes sources anglophones (première version du module) : retirées, le site ne publie qu'en français.
const OLD_ENGLISH_SITES = [
  'https://www.vaticannews.va/en.html', 'https://www.oikoumene.org', 'https://www.anglicannews.org', 'https://evangelicalfocus.com',
  'https://www.christianitytoday.com', 'https://www.baptistpress.com', 'https://www.opendoors.org',
];

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS actu_articles (
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
    CREATE INDEX IF NOT EXISTS actu_articles_status_date_idx ON actu_articles (status, created_at DESC);
    CREATE INDEX IF NOT EXISTS actu_articles_source_url_idx ON actu_articles (source_url);

    CREATE TABLE IF NOT EXISTS actu_images (
      id SERIAL PRIMARY KEY,
      article_id INTEGER NOT NULL REFERENCES actu_articles(id) ON DELETE CASCADE,
      mime TEXT NOT NULL,
      data BYTEA NOT NULL,
      caption TEXT,
      is_cover BOOLEAN NOT NULL DEFAULT false,
      position INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS actu_images_article_idx ON actu_images (article_id);

    CREATE TABLE IF NOT EXISTS actu_sources (
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

    CREATE TABLE IF NOT EXISTS actu_suggestions (
      id SERIAL PRIMARY KEY,
      source_id INTEGER REFERENCES actu_sources(id) ON DELETE SET NULL,
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
    CREATE INDEX IF NOT EXISTS actu_suggestions_status_idx ON actu_suggestions (status, created_at DESC);

    CREATE TABLE IF NOT EXISTS actu_meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  const { rows } = await pool.query('SELECT count(*)::int AS n FROM actu_sources');
  if (rows[0].n === 0) {
    for (const s of DEFAULT_SOURCES) {
      await pool.query(
        'INSERT INTO actu_sources (name, site_url, feed_url, language, region, category) VALUES ($1,$2,$3,$4,$5,$6)',
        [s.name, s.site_url, s.feed_url, s.language, s.region, s.category]
      );
    }
  }
  await migrateToFrench();
}

// Passage au « français uniquement » et aux sources de toutes confessions (une seule fois)
async function migrateToFrench() {
  const done = await pool.query("SELECT 1 FROM actu_meta WHERE key = 'sources_fr_v1'");
  if (done.rows.length) return;
  await pool.query("DELETE FROM actu_sources WHERE language <> 'fr' AND site_url = ANY($1)", [OLD_ENGLISH_SITES]);
  await pool.query("UPDATE actu_sources SET enabled = false WHERE language <> 'fr'");
  await pool.query("UPDATE actu_suggestions SET status = 'rejetee' WHERE status = 'nouvelle' AND language <> 'fr'");
  for (const s of DEFAULT_SOURCES) {
    const ex = await pool.query('SELECT 1 FROM actu_sources WHERE site_url = $1', [s.site_url]);
    if (!ex.rows.length) {
      await pool.query(
        'INSERT INTO actu_sources (name, site_url, feed_url, language, region, category) VALUES ($1,$2,$3,$4,$5,$6)',
        [s.name, s.site_url, s.feed_url, s.language, s.region, s.category]
      );
    }
  }
  await pool.query("DELETE FROM actu_meta WHERE key = 'last_fetch_date'"); // nouvelle recherche dès le prochain passage
  await pool.query("INSERT INTO actu_meta (key, value) VALUES ('sources_fr_v1', '1') ON CONFLICT (key) DO NOTHING");
}

module.exports = { ensureSchema, migrateToFrench, CATEGORIES, REGIONS };
