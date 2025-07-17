const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const path = require('path');
const fs = require('fs');

// Vamos testar apenas um estabelecimento para isolar o problema
const ESTABLISHMENT_NAME = 'pizzaria_padrao';

async function connectToWhatsApp() {
    console.log(`[DIAGNOSTIC TEST] Attempting to connect ${ESTABLISHMENT_NAME}...`);

    const authPath = path.join(__dirname, 'establishments', ESTABLISHMENT_NAME, 'baileys_auth_info');
    
    // Garante que a pasta de autenticação exista
    if (!fs.existsSync(authPath)) {
        fs.mkdirSync(authPath, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(authPath);

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true, // Essencial para vermos o QR nos logs
        browser: ['ZappiBot', 'Chrome', '1.0.0'],
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log(`[DIAGNOSTIC TEST] QR code received. Scan it from the terminal.`);
        }

        if (connection === 'open') {
            console.log(`[DIAGNOSTIC TEST] Connection successful! The environment is working.`);
            // Se chegarmos aqui, o problema está no nosso launcher.js
        }

        if (connection === 'close') {
            const reason = new Boom(lastDisconnect?.error)?.output.statusCode;
            console.error(`[DIAGNOSTIC TEST] Connection closed. Reason: ${reason}`);

            if (reason !== DisconnectReason.loggedOut) {
                console.log('[DIAGNOSTIC TEST] Reconnecting...');
                connectToWhatsApp();
            } else {
                console.log('[DIAGNOSTIC TEST] Logged out. Please delete the auth folder and restart.');
            }
        }
    });
}

// Inicia o teste
connectToWhatsApp();
