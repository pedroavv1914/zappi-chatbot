const fs = require('fs');
const express = require('express');
const http = require('http');
const qrcode = require('qrcode');
const { startBot } = require('./src/bot.js');
const { Boom } = require('@hapi/boom');
const { DisconnectReason } = require('@whiskeysockets/baileys');
const { establishmentsPath } = require('./src/config');

const PORT = process.env.PORT || 3000;

// Objeto para armazenar as instâncias dos bots e seus QR codes
const bots = {};

// --- Lógica de Inicialização ---

// Garante que a pasta de estabelecimentos exista (essencial para o primeiro deploy no Render)
if (!fs.existsSync(establishmentsPath)) {
    console.log(`[Launcher] Criando diretório de estabelecimentos em: ${establishmentsPath}`);
    fs.mkdirSync(establishmentsPath, { recursive: true });
}

const establishmentDirs = fs.readdirSync(establishmentsPath, { withFileTypes: true })
    .filter(dirent => dirent.isDirectory())
    .map(dirent => dirent.name);

// --- Lançador de Bots ---

if (establishmentDirs.length === 0) {
    console.log('Nenhum estabelecimento encontrado. Crie subdiretórios dentro da pasta /establishments.');
} else {
    console.log(`Encontrados ${establishmentDirs.length} estabelecimentos. Iniciando bots...`);
    establishmentDirs.forEach((name) => {
        // Usamos uma função para poder chamá-la recursivamente em caso de logout
        const launch = async (establishmentName) => {
            console.log(`-> Iniciando bot para: ${establishmentName}`);
            const sock = await startBot(establishmentName);
            // Se o startBot falhar (ex: menu.json não encontrado), ele retorna undefined
            if (!sock) {
                console.error(`[${establishmentName}] Falha ao iniciar o bot. Verifique os logs.`);
                return;
            }
            bots[establishmentName] = { sock, qr: null };

            sock.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect, qr } = update;

                if (qr) {
                    bots[establishmentName].qr = qr;
                    console.log(`[${establishmentName}] NOVO QR CODE! Acesse o link para escanear: http://localhost:${PORT}/?name=${establishmentName}`);
                }

                if (connection === 'open') {
                    bots[establishmentName].qr = null; // Limpa o QR code após a conexão
                    console.log(`[${establishmentName}] Conectado com sucesso!`);
                }

                if (connection === 'close') {
                    const reason = new Boom(lastDisconnect.error)?.output.statusCode;
                    // Se foi desconectado pelo usuário, reinicia o bot para gerar novo QR
                    if (reason === DisconnectReason.loggedOut) {
                        console.log(`[${establishmentName}] Desconectado. Reiniciando para obter novo QR Code...`);
                        delete bots[establishmentName];
                        await launch(establishmentName);
                    }
                }
            });
        };

        launch(name);
    });
}

// --- Servidor Web para QR Code ---

const app = express();
const server = http.createServer(app);

app.get('/', (req, res) => {
    const establishmentName = req.query.name;

    if (establishmentName && bots[establishmentName]?.qr) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>QR Code para ${establishmentName}</title>
                <style>body { font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; background-color: #f0f2f5; margin: 0; } h1 { color: #1c1e21; } img { border: 1px solid #ddd; padding: 10px; background: white; box-shadow: 0 4px 8px rgba(0,0,0,0.1); }</style>
            </head>
            <body>
                <h1>Escaneie para conectar: ${establishmentName.replace(/_/g, ' ')}</h1>
                <img src="/qrcode?name=${establishmentName}" alt="QR Code" />
            </body>
            </html>
        `);
    } else {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        let body = `
            <!DOCTYPE html>
            <html>
            <head>
                <title>Painel de Controle ZappiBot</title>
                <style>body { font-family: sans-serif; padding: 2em; background-color: #f0f2f5; color: #333; } ul { list-style-type: none; padding: 0; } li { background: white; margin-bottom: 10px; padding: 15px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); display: flex; justify-content: space-between; align-items: center; } .status-ok { color: green; font-weight: bold; } .status-qr { color: orange; font-weight: bold; }</style>
                <meta http-equiv="refresh" content="15">
            </head>
            <body>
                <h1>Painel de Controle ZappiBot</h1>
                <h2>Bots Ativos:</h2>
                <ul>`;
        if (Object.keys(bots).length > 0) {
            Object.keys(bots).forEach(name => {
                const isConnected = bots[name]?.sock?.ws?.readyState === 1;
                const status = isConnected ? '<span class="status-ok">Conectado ✅</span>' : '<span class="status-qr">Aguardando QR Code 📱</span>';
                const qrLink = !isConnected && bots[name]?.qr ? `<a href="/?name=${name}">Ver QR Code</a>` : 'N/A';
                body += `<li><b>${name.replace(/_/g, ' ')}</b> <span>Status: ${status} | QR Code: ${qrLink}</span></li>`;
            });
        } else {
            body += '<li>Nenhum bot em execução. Verifique os logs ou crie um estabelecimento.</li>';
        }
        body += '</ul><p>Esta página atualiza a cada 15 segundos.</p></body></html>';
        res.end(body);
    }
});

app.get('/qrcode', (req, res) => {
    const establishmentName = req.query.name;
    if (establishmentName && bots[establishmentName]?.qr) {
        qrcode.toFileStream(res, bots[establishmentName].qr, { type: 'png' });
    } else {
        res.status(404).send('QR Code não encontrado ou bot já conectado.');
    }
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 Servidor de controle rodando em http://localhost:${PORT}`);
    console.log('Acesse a URL acima para ver o status e escanear os QR codes.');
});
