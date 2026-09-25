const { Pool } = require('pg');

// Render fournit DATABASE_URL automatiquement quand la base est liée au service.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('render.com')
    ? { rejectUnauthorized: false }
    : false,
});

module.exports = pool;
