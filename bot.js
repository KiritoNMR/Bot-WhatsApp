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

// Extrae el texto de respuesta aunque la IA devuelva JSON crudo
function extraerTextoIA(t) {
  const s = t.trim();
  if (s.startsWith('{')) {
    try {
      const j = JSON.parse(s);
      const c = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
      if (c) return String(c).trim();
      for (const k of ['content', 'text', 'answer', 'response', 'message', 'result']) {
        if (typeof j[k] === 'string' && j[k].trim()) return j[k].trim();
      }
      if (typeof j.reasoning === 'string') {
        const lineas = j.reasoning.split('\n').map((x) => x.trim()).filter((x) => x.length > 10);
        const conNumero = lineas.filter((x) => /\d/.test(x));
        if (conNumero.length) return conNumero[conNumero.length - 1];
        if (lineas.length) return lineas[lineas.length - 1];
      }
    } catch (e) {}
  }
  return s;
}

// ---- IA: Gemini (principal, con clave gratis) + Pollinations (respaldo) ----
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || '').trim();
const GEMINI_MODELOS = (process.env.GEMINI_MODEL || 'gemini-3.8-flash,gemini-3.5-flash').split(',').map((s) => s.trim()).filter(Boolean);

async function fetchConTimeout(url, opciones, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, Object.assign({}, opciones, { signal: ctrl.signal }));
  } finally {
    clearTimeout(timer);
  }
}

async function preguntarIA(pregunta) {
  // Si preguntan hora/fecha, inyectamos el dato real de Cuba para que no invente ni use marcadores
  let contexto = '';
  const ql = pregunta.toLowerCase();
  if (ql.includes('hora') || ql.includes('fecha') || ql.includes('qué día') || ql.includes('que dia') || ql.includes('hoy')) {
    try {
      const ahora = new Date();
      const horaCu = new Intl.DateTimeFormat('es-CU', { timeZone: 'America/Havana', hour: '2-digit', minute: '2-digit' }).format(ahora);
      const fechaCu = new Intl.DateTimeFormat('es-CU', { timeZone: 'America/Havana', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(ahora);
      contexto = 'Dato real: hoy es ' + fechaCu + ' y la hora actual en Cuba es ' + horaCu + '. Úsalo para responder. ';
    } catch (e) {}
  }
  const prompt = 'Responde en español, de forma breve y amable (máximo 4 líneas). Nunca uses marcadores de posición como [insertar...]. Pregunta: ' + contexto + pregunta;

  // 1) Gemini (gratis con API key)
  if (GEMINI_API_KEY) {
    for (const modelo of GEMINI_MODELOS) {
      try {
        const res = await fetchConTimeout(
          'https://generativelanguage.googleapis.com/v1beta/models/' + modelo + ':generateContent',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: { maxOutputTokens: 2000, temperature: 0.7 }
            })
          },
          60000
        );
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        const partes = data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
        const texto = partes ? partes.map((p) => p.text || '').join('').trim() : '';
        if (texto) return texto;
        throw new Error('Sin respuesta');
      } catch (e) {
        console.log(`⚠️ Gemini (${modelo}):`, e.message);
      }
    }
  }

  // 2) Respaldo: Pollinations gratis (2 intentos)
  for (let intento = 0; intento < 2; intento++) {
    try {
      const res = await fetchConTimeout(
        'https://text.pollinations.ai/' + encodeURIComponent(prompt) + '?model=openai',
        {},
        60000
      );
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const texto = extraerTextoIA(await res.text());
      if (texto) return texto;
      throw new Error('Sin respuesta');
    } catch (e) {
      console.log(`⚠️ Pollinations (intento ${intento + 1}):`, e.message);
      if (intento === 0) await sleep(3000);
    }
  }
  return null;
}

// ---- Bienvenida a nuevos miembros ----
const GRUPO_BIENVENIDA = 'General'; // nombre del grupo donde dar la bienvenida (grupo General de la comunidad RedLegion)
// Grupos donde el bot está APAGADO del todo (no responde a nada). Escribe el nombre exacto del grupo.
const GRUPOS_APAGADOS = [];
const OFF_FILE = 'grupos-off.json';
let gruposApagados = new Set(); // ids de grupos con el bot apagado (lista fija + comandos /bot)
let nombresGrupos = {}; // id del grupo -> nombre (se llena al conectar)

// Carga los grupos apagados: lista fija por nombre + los apagados con /bot off
function cargarApagados() {
  try {
    gruposApagados = new Set(JSON.parse(fs.readFileSync(OFF_FILE, 'utf8')));
  } catch (e) { gruposApagados = new Set(); }
  for (const [gid, nombre] of Object.entries(nombresGrupos)) {
    if (GRUPOS_APAGADOS.includes(nombre)) gruposApagados.add(gid);
  }
  console.log(`🔇 Grupos con bot apagado: ${gruposApagados.size}`);
}
function guardarApagados() {
  try { fs.writeFileSync(OFF_FILE, JSON.stringify([...gruposApagados])); }
  catch (e) { console.log('⚠️ No se pudo guardar la lista de apagados:', e.message); }
}
const normJid = (j) => (j || '').split(':')[0].split('@')[0];
async function esAdminGrupo(sock, grupoId, senderJid) {
  try {
    const meta = await sock.groupMetadata(grupoId);
    const s = normJid(senderJid);
    return meta.participants.some((p) => normJid(p.id) === s && (p.admin === 'admin' || p.admin === 'superadmin'));
  } catch (e) { return false; }
}

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
        cargarApagados();
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
    const esGrupo = from.endsWith('@g.us');
    // Responde a mensajes de otros, y a los tuyos solo en tu chat personal ("Tú")
    // WhatsApp usa @lid además de tu número: se comparan ambas identidades
    const yoIds = sock.user ? [sock.user.id, sock.user.lid].filter(Boolean).map(normJid) : [];
    const chatIds = [from, msg.key.remoteJidAlt].filter(Boolean).map(normJid);
    const isSelfChat = !!(msg.key.fromMe && !esGrupo && chatIds.some((c) => yoIds.includes(c)));
    const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').toLowerCase().trim();
    console.log(`💬 Mensaje de ${from} (alt: ${msg.key.remoteJidAlt || '-'}, yo: ${yoIds.join(',')}, selfChat: ${isSelfChat}): ${text}`);
    if (!text) return;
    const esToggle = text === '/bot off' || text === '/bot on';
    // Ignora tus mensajes en otros chats, excepto los comandos /bot
    if (msg.key.fromMe && !isSelfChat && !esToggle) return;

    // /bot on|off — solo en grupos y solo administradores
    if (esToggle) {
      if (!esGrupo) {
        await sock.sendMessage(from, { text: 'Este comando solo funciona en grupos.' });
        return;
      }
      const sender = msg.key.participant || (msg.key.fromMe ? sock.user.id : from);
      if (!(await esAdminGrupo(sock, from, sender))) {
        await sock.sendMessage(from, { text: '⛔ Solo los administradores del grupo pueden usar este comando.' });
        return;
      }
      if (text === '/bot off') {
        gruposApagados.add(from);
        guardarApagados();
        await sock.sendMessage(from, { text: '🔴 Bot apagado en este grupo.' });
      } else {
        gruposApagados.delete(from);
        guardarApagados();
        await sock.sendMessage(from, { text: '🟢 Bot encendido en este grupo.' });
      }
      return;
    }

    // En grupos apagados el bot no responde a nada; en el grupo de bienvenida solo da la bienvenida (sin comandos)
    if (esGrupo) {
      if (gruposApagados.has(from)) return;
      if (nombresGrupos[from] === GRUPO_BIENVENIDA) return;
    }

    let reply = null;
    if (text === '/hola') {
      reply = '👋 ¡Hola! Soy Kaneki. Escribe */ayuda* para ver qué puedo hacer.';
    } else if (text === '/ayuda') {
      reply = '📋 Comandos:\n• */hola* - Saludar\n• */ia <pregunta>* - Pregúntame lo que quieras\n• */ayuda* - Este mensaje\n\n💬 En privado puedes escribirme normal y te respondo con IA sin usar /ia';
    } else if (text === '/ia' || text.startsWith('/ia ')) {
      const pregunta = text.slice(3).trim();
      if (!pregunta) {
        reply = '🤖 Escríbeme una pregunta, por ejemplo:\n*/ia ¿cuál es la capital de Japón?*';
      } else {
        try {
          await sock.sendPresenceUpdate('composing', from);
          const respuesta = await preguntarIA(pregunta);
          reply = respuesta ? '🤖 ' + respuesta : '😅 No pude contactar a la IA ahora mismo, intenta en un momento.';
        } catch (e) {
          console.log('⚠️ Error con la IA:', e.message);
          reply = '😅 No pude contactar a la IA ahora mismo, intenta en un momento.';
        }
      }
    } else if (!esGrupo) {
      // En chats privados, cualquier mensaje va directo a la IA (sin /ia)
      try {
        await sock.sendPresenceUpdate('composing', from);
        const respuesta = await preguntarIA(text);
        reply = respuesta ? '🤖 ' + respuesta : '😅 No pude contactar a la IA ahora mismo, intenta en un momento.';
      } catch (e) {
        console.log('⚠️ Error con la IA (directo):', e.message);
        reply = '😅 No pude contactar a la IA ahora mismo, intenta en un momento.';
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
      if (gruposApagados.has(id)) return;
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
