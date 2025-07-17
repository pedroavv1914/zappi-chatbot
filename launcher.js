const fs = require('fs');
const path = require('path');
const http = require('http');
const qrcode = require('qrcode');
const { startBot } = require('./src/bot.js');
const { Boom } = require('@hapi/boom');
const { DisconnectReason } = require('@whiskeysockets/baileys');

const establishmentsDir = path.join(__dirname, 'establishments');
const PORT = 3000;

// Objeto para armazenar as instâncias dos bots e seus QR codes
const bots = {};

// Inicia os bots para cada estabelecimento
fs.readdir(establishmentsDir, { withFileTypes: true }, (err, files) => {
    if (err) {
        console.error('Erro ao ler o diretório de estabelecimentos:', err);
        return;
    }

    const establishmentDirs = files.filter(dirent => dirent.isDirectory()).map(dirent => dirent.name);

    if (establishmentDirs.length === 0) {
        console.log('Nenhum estabelecimento encontrado na pasta /establishments. Crie uma pasta para cada um.');
        return;
    }

    console.log(`Encontrados ${establishmentDirs.length} estabelecimentos. Iniciando bots...`);

    establishmentDirs.forEach((name) => {
        // Usamos uma função para poder chamá-la recursivamente em caso de logout
        const launch = async (establishmentName) => {
            console.log(`-> Iniciando bot para: ${establishmentName}`);
            const sock = await startBot(establishmentName);
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
                        // Remove a instância antiga antes de recriar
                        delete bots[establishmentName];
                        await launch(establishmentName);
                    }
                }
            });
        };

        launch(name);
    });
});

// Configura o servidor HTTP para exibir os QR codes
const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const establishmentName = url.searchParams.get('name');

    if (url.pathname === '/' && establishmentName && bots[establishmentName]?.qr) {
        // Exibe o QR code para um estabelecimento específico
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>QR Code para ${establishmentName}</title>
                <style>body { font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; background-color: #f0f2f5; }</style>
            </head>
            <body>
                <h1>Escaneie para conectar: ${establishmentName.replace(/_/g, ' ')}</h1>
                <img src="/qrcode?name=${establishmentName}" alt="QR Code" />
            </body>
            </html>
        `);
    } else if (url.pathname === '/qrcode' && establishmentName && bots[establishmentName]?.qr) {
        // Gera a imagem do QR code
        qrcode.toFileStream(res, bots[establishmentName].qr, { type: 'png' });
    } else {
        // Página inicial que lista os bots
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        let body = '<h1>Painel de Controle ZappiBot</h1><h2>Bots Ativos:</h2><ul>';
        Object.keys(bots).forEach(name => {
            const status = bots[name].sock.ws.readyState === 1 ? 'Conectado ✅' : 'Aguardando QR Code 📱';
            const qrLink = bots[name].qr ? `<a href="/?name=${name}">Ver QR Code</a>` : 'N/A';
            body += `<li><b>${name.replace(/_/g, ' ')}</b> - Status: ${status} | QR Code: ${qrLink}</li>`;
        });
        body += '</ul><p>Atualize a página para ver novos QR codes.</p>';
        res.end(body);
    }
});

server.listen(PORT, () => {
    console.log(`\n🚀 Servidor de controle rodando em http://localhost:${PORT}`);
    console.log('Acesse a URL acima para ver o status e escanear os QR codes.');
});
