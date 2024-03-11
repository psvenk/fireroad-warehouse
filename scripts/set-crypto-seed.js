const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const randomSeed = crypto.randomBytes(32).toString('hex');
const sqlnetFile = path.resolve(__dirname, '..', 'warehouse-conf', 'sqlnet.ora');

const src = fs.readFileSync(sqlnetFile, 'utf-8');
const seeded = src.replace('#DYNAMICALLY_GENERATED_RANDOM_SEED#', randomSeed);
fs.writeFileSync(sqlnetFile, seeded);