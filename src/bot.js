const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const {
    getSession,
    updateSession,
    deleteSession,
    getCooldown,
    setCooldown,
    createOrder
} = require('./database');
const { establishmentsPath } = require('./config');

// Função para iniciar uma instância do bot para um estabelecimento específico
async function startBot(establishmentName) {
    const establishmentPath = path.join(establishmentsPath, establishmentName);
    const authPath = path.join(establishmentPath, 'baileys_auth_info');
    const menuPath = path.join(establishmentPath, 'menu.json');

    if (!fs.existsSync(menuPath)) {
        console.error(`[${establishmentName}] Erro: Arquivo menu.json não encontrado em ${establishmentPath}`);
        return;
    }

    const menu = require(menuPath);
    const COOLDOWN_TIME = 5 * 60 * 1000; // 5 minutos

    const CONVERSATION_STATES = {
        INITIAL: 'initial',
        AWAITING_MENU_CHOICE: 'awaiting_menu_choice',
        AWAITING_ORDER_ITEMS: 'awaiting_order_items',
        AWAITING_ORDER_CONFIRMATION: 'awaiting_order_confirmation',
        AWAITING_DELIVERY_CHOICE: 'awaiting_delivery_choice',
        AWAITING_FULL_NAME: 'awaiting_full_name',
        AWAITING_PHONE: 'awaiting_phone',
        AWAITING_ADDRESS: 'awaiting_address',
    };

    console.log(`[${establishmentName}] Iniciando bot...`);

    const { state, saveCreds } = await useMultiFileAuthState(authPath);

    const sock = makeWASocket({
        browser: ['ZappiBot', 'Chrome', '1.0.0'], // Identificador do navegador
        logger: pino({ level: 'silent' }),
        auth: state
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const reason = new Boom(lastDisconnect?.error)?.output.statusCode;
            console.log(`[${establishmentName}] Conexão fechada. Razão: ${reason}`);
            if (reason === DisconnectReason.loggedOut) {
                console.log(`[${establishmentName}] Desconectado pelo usuário. Removendo autenticação... O launcher irá gerar um novo QR Code.`);
                // A pasta de autenticação é removida para forçar um novo QR code na próxima inicialização.
                fs.rmSync(authPath, { recursive: true, force: true });
            } else {
                console.log(`[${establishmentName}] Conexão perdida. Tentando reconectar...`);
            }
        } else if (connection === 'open') {
            console.log(`[${establishmentName}] Conexão aberta com sucesso!`);
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const message of messages) {
            const senderJid = message.key.remoteJid;
            const messageContent = message.message?.conversation || message.message?.extendedTextMessage?.text || '';
            if (!messageContent) continue;

            const cooldown = await getCooldown(senderJid, establishmentName);
            if (cooldown && cooldown.cooldown_until > Date.now()) {
                console.log(`[${establishmentName}] Cooldown ativo para ${senderJid}. Ignorando mensagem.`);
                continue;
            }

            let session = await getSession(senderJid, establishmentName);

            if (!session) {
                session = { state: CONVERSATION_STATES.INITIAL, order: [], jid: senderJid, establishmentName };
            }

            let newSession = session; // Começa com a sessão atual

            switch (session.state) {
                case CONVERSATION_STATES.INITIAL:
                    newSession = await handleInitialState(sock, session);
                    break;
                case CONVERSATION_STATES.AWAITING_MENU_CHOICE:
                    newSession = await handleMenuChoice(sock, session, messageContent);
                    break;
                case CONVERSATION_STATES.AWAITING_ORDER_ITEMS:
                    newSession = await handleOrderItems(sock, session, messageContent);
                    break;
                case CONVERSATION_STATES.AWAITING_ORDER_CONFIRMATION:
                    newSession = await handleOrderConfirmation(sock, session, messageContent);
                    break;
                case CONVERSATION_STATES.AWAITING_DELIVERY_CHOICE:
                    newSession = await handleDeliveryChoice(sock, session, messageContent);
                    break;
                case CONVERSATION_STATES.AWAITING_FULL_NAME:
                    newSession = await handleFullName(sock, session, messageContent);
                    break;
                case CONVERSATION_STATES.AWAITING_PHONE:
                    newSession = await handlePhone(sock, session, messageContent);
                    break;
                case CONVERSATION_STATES.AWAITING_ADDRESS:
                    newSession = await handleAddress(sock, session, messageContent);
                    break;
                default:
                    await sock.sendMessage(senderJid, { text: 'Desculpe, não entendi. Reiniciando atendimento.' });
                    newSession = await handleInitialState(sock, session);
                    break;
            }

            // Se a newSession não for nula, atualiza no banco. Se for nula, a sessão foi encerrada.
            if (newSession) {
                await updateSession(senderJid, establishmentName, newSession);
            } else {
                await deleteSession(senderJid, establishmentName);
                await setCooldown(senderJid, establishmentName, Date.now() + COOLDOWN_TIME);
            }
        }
    });

    async function handleInitialState(sock, session) {
        const welcomeText = `🍕 Bem-vindo(a) à *${establishmentName.replace(/_/g, ' ')}*! 🍕\n\nComo posso ajudar?\n\n*1. Ver Cardápio* 📋\n*2. Fazer Pedido* 📝\n*3. Falar com um atendente* 🧑‍💼`;
        await sock.sendMessage(session.jid, { text: welcomeText });
        session.state = CONVERSATION_STATES.AWAITING_MENU_CHOICE;
        return session;
    }

    async function displayMenu(sock, jid) {
        let menuText = '⭐ *Nosso Cardápio* ⭐\n\n';
        menuText += '🍕 *Pizzas*\n';
        menu.pizzas.forEach(pizza => {
            menuText += `*${pizza.id}. ${pizza.name}* - R$ ${pizza.price.toFixed(2)}\n_Ingredientes: ${pizza.ingredients}_\n\n`;
        });
        menuText += '🥤 *Bebidas*\n';
        menu.bebidas.forEach(bebida => {
            menuText += `*${bebida.id}. ${bebida.name}* - R$ ${bebida.price.toFixed(2)}\n`;
        });
        menuText += '\nPara fazer um pedido, escolha a opção *2* no menu principal.';
        await sock.sendMessage(jid, { text: menuText });
    }

    async function handleMenuChoice(sock, session, messageContent) {
        switch (messageContent.trim()) {
            case '1':
                await displayMenu(sock, session.jid);
                // O estado não muda, apenas mostra o menu
                return session;
            case '2':
                await sock.sendMessage(session.jid, { text: 'Ótimo! Por favor, digite os números dos itens que deseja pedir, separados por vírgula (ex: 1,4,5).' });
                session.state = CONVERSATION_STATES.AWAITING_ORDER_ITEMS;
                session.order = []; // Limpa o pedido anterior
                return session;
            case '3':
                await sock.sendMessage(session.jid, { text: 'Encaminhando você para um atendente. Por favor, aguarde.' });
                await createOrder(establishmentName, session.jid, [], { type: 'Atendente' });
                return null; // Encerra a sessão
            default:
                await sock.sendMessage(session.jid, { text: 'Opção inválida. Por favor, escolha 1, 2 ou 3.' });
                return session;
        }
    }

    async function handleOrderItems(sock, session, messageContent) {
        const itemIds = messageContent.split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id));
        let selectedItems = [];
        itemIds.forEach(id => {
            const item = menu.pizzas.find(p => p.id === id) || menu.bebidas.find(b => b.id === id);
            if (item) selectedItems.push(item);
        });

        if (selectedItems.length > 0) {
            session.order.push(...selectedItems);
            let orderSummary = '🛒 *Seu Pedido:* 🛒\n\n';
            session.order.forEach(item => {
                orderSummary += `- ${item.name} (R$ ${item.price.toFixed(2)})\n`;
            });
            const total = session.order.reduce((sum, item) => sum + item.price, 0);
            orderSummary += `\n💰 *Total:* R$ ${total.toFixed(2)}\n`;
            orderSummary += '✅ Para confirmar, digite *Sim*. Para cancelar, digite *Não*.\nSe quiser adicionar mais itens, digite os números novamente.';
            await sock.sendMessage(session.jid, { text: orderSummary });
            session.state = CONVERSATION_STATES.AWAITING_ORDER_CONFIRMATION;
        } else {
            await sock.sendMessage(session.jid, { text: 'Nenhum item válido foi selecionado. Por favor, digite os números dos itens.' });
        }
        return session;
    }

    async function handleOrderConfirmation(sock, session, messageContent) {
        const confirmation = messageContent.trim().toLowerCase();
        if (confirmation === 'sim') {
            await sock.sendMessage(session.jid, { text: 'Pedido confirmado!\n\nComo você prefere?\n*Retirar* no local ou *Delivery*?' });
            session.state = CONVERSATION_STATES.AWAITING_DELIVERY_CHOICE;
            return session;
        } else if (confirmation === 'não') {
            await sock.sendMessage(session.jid, { text: 'Pedido cancelado. Voltando ao menu principal.' });
            return null; // Encerra a sessão
        } else {
            // Permite adicionar mais itens
            return await handleOrderItems(sock, session, messageContent);
        }
    }

    async function handleDeliveryChoice(sock, session, messageContent) {
        const choice = messageContent.trim().toLowerCase();
        if (choice === 'retirar') {
            let orderSummary = '✅ *Pedido Confirmado para Retirada!* ✅\n\n';
            orderSummary += '*Seu Pedido:*\n';
            session.order.forEach(item => {
                orderSummary += `- ${item.name} (R$ ${item.price.toFixed(2)})\n`;
            });
            const total = session.order.reduce((sum, item) => sum + item.price, 0);
            orderSummary += `\n💰 *Total:* R$ ${total.toFixed(2)}\n\n`;
            orderSummary += 'Agradecemos a preferência! Seu pedido será preparado para retirada.';
            await sock.sendMessage(session.jid, { text: orderSummary });
            await createOrder(establishmentName, session.jid, session.order, { type: 'Retirada' });
            return null; // Encerra a sessão

        } else if (choice === 'delivery') {
            await sock.sendMessage(session.jid, { text: 'Ótimo! Para o delivery, preciso de algumas informações. Por favor, digite seu nome completo:' });
            session.state = CONVERSATION_STATES.AWAITING_FULL_NAME;
            return session;
        } else {
            await sock.sendMessage(session.jid, { text: 'Opção inválida. Por favor, digite "retirar" ou "delivery".' });
            return session;
        }
    }

    async function handleFullName(sock, session, messageContent) {
        session.fullName = messageContent.trim();
        await sock.sendMessage(session.jid, { text: 'Obrigado! Agora, por favor, digite seu telefone para contato:' });
        session.state = CONVERSATION_STATES.AWAITING_PHONE;
        return session;
    }

    async function handlePhone(sock, session, messageContent) {
        session.phone = messageContent.trim();
        await sock.sendMessage(session.jid, { text: 'Perfeito! Por último, digite seu endereço completo para entrega:' });
        session.state = CONVERSATION_STATES.AWAITING_ADDRESS;
        return session;
    }

    async function handleAddress(sock, session, messageContent) {
        session.address = messageContent.trim();
        let finalOrderSummary = '✅ *Pedido Confirmado para Delivery!* ✅\n\n';
        finalOrderSummary += '*Seu Pedido:*\n';
        session.order.forEach(item => {
            finalOrderSummary += `- ${item.name} (R$ ${item.price.toFixed(2)})\n`;
        });
        const total = session.order.reduce((sum, item) => sum + item.price, 0);
        finalOrderSummary += `\n💰 *Total:* R$ ${total.toFixed(2)}\n\n`;
        finalOrderSummary += '*Dados para Entrega:*\n';
        finalOrderSummary += `Nome: ${session.fullName}\n`;
        finalOrderSummary += `Telefone: ${session.phone}\n`;
        finalOrderSummary += `Endereço: ${session.address}\n\n`;
        finalOrderSummary += 'Agradecemos a preferência! Seu pedido será entregue em breve.';
        await sock.sendMessage(session.jid, { text: finalOrderSummary });
        await createOrder(establishmentName, session.jid, session.order, { type: 'Delivery', address: session.address, name: session.fullName, phone: session.phone });
        return null; // Encerra a sessão
    }

    // A função resetUserState não é mais necessária, pois a lógica foi centralizada.

    return sock;
}

module.exports = { startBot };
