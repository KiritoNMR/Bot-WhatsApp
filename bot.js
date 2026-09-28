const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const readline = require('readline');
const express = require('express');

// ---- Servidor web para keep-alive (UptimeRobot lo pingea y no se duerme) ----
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('🤖 Bot de WhatsApp activo'));
app.listen(PORT, () => console.log(`🌐 Servidor keep-alive en puerto ${PORT}`));
// ----------------------------------------------------------------------------

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((res) => rl.question(q, res));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pairingAsked = false;

async function startBot() {
  console.log('🚀 Iniciando bot...');
  const { state, saveCreds } = await useMultiFileAuthState('auth');
  console.log('📦 Sesión lista, conectando a WhatsApp...');

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    markOnlineOnConnect: false,
  });

  sock.ev.on('creds.update', saveCreds);

  // Si tarda más de 90s en conectar, avisar
  const watchdog = setTimeout(() => {
    console.log('\n⚠️ Lleva mucho tiempo conectando.');
    console.log('La red del servidor podría estar bloqueando WhatsApp Web. Reintenta con Run.');
  }, 90000);

  // Pedir código de vinculación si no hay sesión (una sola vez, con reintentos)
  if (!state.creds.registered && !pairingAsked) {
    pairingAsked = true;
    setTimeout(async () => {
      const phone = await ask('📱 Escribe tu número con código de país (ej: 5351234567): ');
      while (!sock.authState.creds.registered) {
        try {
          const code = await sock.requestPairingCode(phone.trim());
          console.log('\n🔑 Tu código de vinculación es:', code);
          console.log('En tu WhatsApp ve a: Ajustes > Dispositivos vinculados > Vincular dispositivo');
          console.log('y escribe ese código.\n');
          break;
        } catch (e) {
          console.log('⏳ Aún conectando, reintentando en 5s...');
          await sleep(5000);
        }
      }
    }, 8000);
  }

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;
    if (connection) console.log('📡 Estado:', connection);

    if (connection === 'open') {
      clearTimeout(watchdog);
      console.log('✅ ¡Bot conectado a WhatsApp!');
    }

    if (connection === 'close') {
      clearTimeout(watchdog);
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      console.log('❌ Conexión cerrada. Motivo:', reason);
      if (reason === DisconnectReason.loggedOut) {
        console.log('Sesión cerrada. Borra la carpeta "auth" y vuelve a vincular con Run.');
        process.exit(0);
      }
      console.log('🔄 Reintentando en 5 segundos...');
      setTimeout(startBot, 5000);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;
    const from = msg.key.remoteJid;
    const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').toLowerCase().trim();
    console.log(`💬 Mensaje de ${from}: ${text}`);
    if (!text) return;

    let reply = null;
    if (text === 'hola') reply = '👋 ¡Hola! Soy tu bot. Escribe *ayuda* para ver qué puedo hacer.';
    else if (text === 'ayuda') reply = '📋 Comandos:\n• *hola* - Saludar\n• *hora* - Ver la hora\n• *ayuda* - Este mensaje';
    else if (text === 'hora') reply = `🕐 Son las ${new Date().toLocaleTimeString('es-ES')}`;

    if (reply) await sock.sendMessage(from, { text: reply });
  });
}

startBot();
