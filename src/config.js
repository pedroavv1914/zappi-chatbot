const path = require('path');

// O Render define esta variável de ambiente com o caminho para o disco persistente.
// Se não estiver no Render, usamos o diretório raiz do projeto como base.
const persistentDataPath = process.env.RENDER_DISK_PATH || path.join(__dirname, '..');

// Caminho para a pasta que conterá todos os dados dos estabelecimentos.
const establishmentsPath = path.join(persistentDataPath, 'establishments');

// Caminho para o arquivo do banco de dados SQLite.
const databasePath = path.join(persistentDataPath, 'zappi.db');

module.exports = {
    establishmentsPath,
    databasePath,
};
