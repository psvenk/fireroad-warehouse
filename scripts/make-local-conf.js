const crypto = require('crypto');
const fs = require('fs');
const path = require('path');


const randomSeed = crypto.randomBytes(32).toString('hex');
const confDir = path.resolve(__dirname, '..', 'warehouse-conf');
const localConfDir = path.resolve(__dirname, '..', 'warehouse-conf.local');

if (!fs.existsSync(localConfDir)) fs.mkdirSync(localConfDir)

for (const file of fs.readdirSync(confDir, { withFileTypes: true })) {
  if (!file.isFile() || !file.name.endsWith('.ora')) continue;
  fs.copyFileSync(path.join(confDir, file.name), path.join(localConfDir, file.name));
}

const sqlnetFile = path.resolve(localConfDir, 'sqlnet.ora');
const src = fs.readFileSync(sqlnetFile, 'utf-8');
const seeded = src.replace('#DYNAMICALLY_GENERATED_RANDOM_SEED#', randomSeed);
fs.writeFileSync(sqlnetFile, seeded);
