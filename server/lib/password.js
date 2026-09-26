const crypto = require('crypto');

// Hache un mot de passe avec un sel aléatoire (scrypt, intégré à Node — pas de dépendance externe)
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

// Vérifie un mot de passe par rapport au hash stocké
function verifyPassword(password, storedHash) {
  const [salt, hash] = storedHash.split(':');
  if (!salt || !hash) return false;
  const testHash = crypto.scryptSync(password, salt, 64).toString('hex');
  const hashBuffer = Buffer.from(hash, 'hex');
  const testBuffer = Buffer.from(testHash, 'hex');
  if (hashBuffer.length !== testBuffer.length) return false;
  return crypto.timingSafeEqual(hashBuffer, testBuffer);
}

module.exports = { hashPassword, verifyPassword };
