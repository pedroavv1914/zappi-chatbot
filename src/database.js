const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

let db;

async function initializeDatabase() {
    if (db) return db;

    db = await open({
        filename: './zappi.db',
        driver: sqlite3.Database
    });

    // Cria as tabelas se elas não existirem
    await db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            establishmentName TEXT NOT NULL,
            jid TEXT NOT NULL,
            state TEXT,
            order_items TEXT,
            full_name TEXT,
            phone TEXT,
            address TEXT
        );

        CREATE TABLE IF NOT EXISTS cooldowns (
            id TEXT PRIMARY KEY,
            establishmentName TEXT NOT NULL,
            jid TEXT NOT NULL,
            cooldown_until INTEGER
        );

        CREATE TABLE IF NOT EXISTS orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            establishmentName TEXT NOT NULL,
            jid TEXT NOT NULL,
            order_details TEXT NOT NULL,
            total_price REAL NOT NULL,
            customer_info TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);

    console.log('Banco de dados inicializado com sucesso.');
    return db;
}

// --- Funções de Sessão (Substitui userStates) ---

async function getSession(jid, establishmentName) {
    const db = await initializeDatabase();
    const session = await db.get('SELECT * FROM sessions WHERE jid = ? AND establishmentName = ?', jid, establishmentName);
    if (session) {
        if (session.order_items) {
            session.order = JSON.parse(session.order_items);
        }
        // Mapeia o nome da coluna do DB para o nome da propriedade do objeto
        if (session.full_name) {
            session.fullName = session.full_name;
        }
    }
    return session;
}

async function updateSession(jid, establishmentName, data) {
    const db = await initializeDatabase();
    const id = `${jid}_${establishmentName}`;
    const order_items = data.order ? JSON.stringify(data.order) : '[]';
    
    await db.run(
        `INSERT INTO sessions (id, establishmentName, jid, state, order_items, full_name, phone, address) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) 
         ON CONFLICT(id) DO UPDATE SET 
         state = excluded.state, 
         order_items = excluded.order_items, 
         full_name = excluded.full_name, 
         phone = excluded.phone, 
         address = excluded.address`, 
        id, establishmentName, jid, data.state, order_items, data.fullName, data.phone, data.address
    );
}

async function deleteSession(jid, establishmentName) {
    const db = await initializeDatabase();
    await db.run('DELETE FROM sessions WHERE jid = ? AND establishmentName = ?', jid, establishmentName);
}

// --- Funções de Cooldown (Substitui userCooldowns) ---

async function getCooldown(jid, establishmentName) {
    const db = await initializeDatabase();
    return await db.get('SELECT cooldown_until FROM cooldowns WHERE jid = ? AND establishmentName = ?', jid, establishmentName);
}

async function setCooldown(jid, establishmentName, timestamp) {
    const db = await initializeDatabase();
    const id = `${jid}_${establishmentName}`;
    await db.run('INSERT INTO cooldowns (id, establishmentName, jid, cooldown_until) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET cooldown_until = excluded.cooldown_until', id, establishmentName, jid, timestamp);
}

// --- Funções de Pedidos ---

async function createOrder(establishmentName, jid, order, customerInfo) {
    const db = await initializeDatabase();
    const order_details = JSON.stringify(order.map(item => ({ name: item.name, price: item.price })));
    const total_price = order.reduce((sum, item) => sum + item.price, 0);
    const customer_info = JSON.stringify(customerInfo);

    await db.run(
        'INSERT INTO orders (establishmentName, jid, order_details, total_price, customer_info) VALUES (?, ?, ?, ?, ?)',
        establishmentName, jid, order_details, total_price, customer_info
    );
}

module.exports = {
    initializeDatabase,
    getSession,
    updateSession,
    deleteSession,
    getCooldown,
    setCooldown,
    createOrder
};
