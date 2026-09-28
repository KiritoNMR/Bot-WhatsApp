const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const fs = require('fs');
const path = require('path');
const express = require('express');

// ---- Configuración por variables de entorno (Render → Environment) ----
const PHONE_NUMBER = (process.env.PHONE_NUMBER || '').trim(); // ej: 5351234567
const SESSION_B64 = (process.env.SESSION_B64 || '').trim();    // respaldo de sesión (opcional)
// -----------------------------------------------------------------------

const AUTH_DIR = 'auth';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Bienvenida a nuevos miembros ----
const GRUPO_BIENVENIDA = 'General'; // nombre del grupo donde dar la bienvenida (grupo General de la comunidad RedLegion)
let nombresGrupos = {}; // id del grupo -> nombre (se llena al conectar)

// Restaurar sesión desde SESSION_B64 si existe (sobrevive reinicios del servidor)
function restoreSession() {
  if (!SESSION_B64) return;
  try {
    const files = JSON.parse(Buffer.from(SESSION_B64, 'base64').toString('utf8'));
    if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
    for (const [name, b64] of Object.entries(files)) {
      fs.writeFileSync(path.join(AUTH_DIR, name), Buffer.from(b64, 'base64'));
    }
    console.log('📂 Sesión restaurada desde SESSION_B64');
  } catch (e) {
    console.log('⚠️ No se pudo restaurar la sesión:', e.message);
  }
}

// Generar respaldo de sesión en base64 (para guardar en SESSION_B64)
function backupSession() {
  try {
    if (!fs.existsSync(AUTH_DIR)) return null;
    const files = {};
    for (const name of fs.readdirSync(AUTH_DIR)) {
      const p = path.join(AUTH_DIR, name);
      if (fs.statSync(p).isFile()) files[name] = fs.readFileSync(p).toString('base64');
    }
    return Buffer.from(JSON.stringify(files)).toString('base64');
  } catch (e) {
    console.log('⚠️ No se pudo generar el respaldo:', e.message);
    return null;
  }
}

// ---- Servidor web para keep-alive (UptimeRobot lo pingea y no se duerme) ----
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('🤖 Bot de WhatsApp activo'));
app.listen(PORT, () => console.log(`🌐 Servidor keep-alive en puerto ${PORT}`));
// ----------------------------------------------------------------------------

let pairingAsked = false;

async function startBot() {
  console.log('🚀 Iniciando bot...');
  restoreSession();
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
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
    console.log('La red del servidor podría estar bloqueando WhatsApp Web.');
  }, 90000);

  // Pedir código de vinculación si no hay sesión (una sola vez, con reintentos)
  if (!state.creds.registered && !pairingAsked) {
    pairingAsked = true;
    setTimeout(async () => {
      if (!PHONE_NUMBER) {
        console.log('⚠️ Configura la variable de entorno PHONE_NUMBER con tu número (ej: 5351234567) y redeploy.');
        return;
      }
      while (!sock.authState.creds.registered) {
        try {
          const code = await sock.requestPairingCode(PHONE_NUMBER);
          console.log('\n🔑 Tu código de vinculación es: ' + code);
          console.log('En tu WhatsApp ve a: Ajustes > Dispositivos vinculados > Vincular dispositivo');
          console.log('y escribe ese código.\n');
          break;
        } catch (e) {
          console.log('⏳ Aún conectando, reintentando código en 5s...');
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
      // Listar grupos para saber sus nombres/ids
      try {
        const todos = await sock.groupFetchAllParticipating();
        for (const [gid, g] of Object.entries(todos)) nombresGrupos[gid] = g.subject;
        console.log(`📋 Grupos detectados: ${Object.keys(nombresGrupos).length}`);
      } catch (e) { console.log('⚠️ No se pudieron listar los grupos:', e.message); }
      // Mostrar respaldo de sesión para sobrevivir reinicios
      const backup = backupSession();
      if (backup) {
        console.log('\n💾 RESPALDO DE SESIÓN (guárdalo en la variable SESSION_B64):');
        console.log(backup);
        console.log('--- fin del respaldo ---\n');
      }
    }

    if (connection === 'close') {
      clearTimeout(watchdog);
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      console.log('❌ Conexión cerrada. Motivo:', reason);
      if (reason === DisconnectReason.loggedOut) {
        console.log('Sesión cerrada. Vuelve a vincular con un código nuevo.');
        process.exit(0);
      }
      console.log('🔄 Reintentando en 5 segundos...');
      setTimeout(startBot, 5000);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message) return;
    const from = msg.key.remoteJid;
    // Responde a mensajes de otros, y a los tuyos solo en tu chat personal ("Tú")
    const isSelfChat = !!(msg.key.fromMe && sock.user && from === sock.user.id);
    if (msg.key.fromMe && !isSelfChat) return;
    // En el grupo de bienvenida los comandos están desactivados (solo bienvenida)
    if (from.endsWith('@g.us') && nombresGrupos[from] === GRUPO_BIENVENIDA) return;
    const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').toLowerCase().trim();
    console.log(`💬 Mensaje de ${from}: ${text}`);
    if (!text) return;

    let reply = null;
    if (text === '/hola') {
      reply = '👋 ¡Hola! Soy Kaneki. Escribe */ayuda* para ver qué puedo hacer.';
    } else if (text === '/ayuda') {
      reply = '📋 Comandos:\n• */hola* - Saludar\n• */ia <pregunta>* - Pregúntame lo que quieras\n• */ayuda* - Este mensaje';
    } else if (text === '/ia' || text.startsWith('/ia ')) {
      const pregunta = text.slice(3).trim();
      if (!pregunta) {
        reply = '🤖 Escríbeme una pregunta, por ejemplo:\n*/ia ¿cuál es la capital de Japón?*';
      } else {
        try {
          await sock.sendPresenceUpdate('composing', from);
          const prompt = encodeURIComponent('Responde en español, de forma breve y amable (máximo 4 líneas). Pregunta: ' + pregunta);
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 60000);
          const res = await fetch('https://text.pollinations.ai/' + prompt, { signal: ctrl.signal });
          clearTimeout(timer);
          if (!res.ok) throw new Error('HTTP ' + res.status);
          const respuesta = (await res.text()).trim();
          reply = respuesta ? '🤖 ' + respuesta : '😅 La IA no me respondió, intenta de nuevo.';
        } catch (e) {
          console.log('⚠️ Error con la IA:', e.message);
          reply = '😅 No pude contactar a la IA ahora mismo, intenta en un momento.';
        }
      }
    }

    if (reply) await sock.sendMessage(from, { text: reply });
  });

  // Dar la bienvenida cuando alguien se une al grupo
  sock.ev.on('group-participants.update', async ({ id, participants, action }) => {
    try {
      console.log(`👥 Evento grupo: ${action} en ${id}`);
      if (action !== 'add') return;
      let nombre = nombresGrupos[id];
      if (!nombre) {
        try {
          nombre = (await sock.groupMetadata(id)).subject;
          nombresGrupos[id] = nombre;
        } catch (e) { return; }
      }
      console.log(`👥 Grupo: "${nombre}"`);
      if (nombre !== GRUPO_BIENVENIDA) return;
      for (const p of participants) {
        const tag = p.split('@')[0];
        await sock.sendMessage(id, {
          text: `🔥 ¡Bienvenido/a a la Red Legión, @${tag}! Espero que la pases bien en esta comunidad 🎮 Si tienes alguna duda pregunta sin pena, aquí nos ayudamos entre todos.`,
          mentions: [p],
        });
        console.log(`👋 Bienvenida enviada a ${tag}`);
      }
    } catch (e) { console.log('⚠️ Error en bienvenida:', e.message); }
  });
}

startBot();
