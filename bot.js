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
const normalizar = (s) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

// ---- Países: nombre normalizado -> [zona horaria, nombre bonito] ----
const PAISES = {
  'afganistan': ['Asia/Kabul', 'Afganistán'],
  'albania': ['Europe/Tirane', 'Albania'],
  'alemania': ['Europe/Berlin', 'Alemania'],
  'andorra': ['Europe/Andorra', 'Andorra'],
  'angola': ['Africa/Luanda', 'Angola'],
  'antigua y barbuda': ['America/Antigua', 'Antigua y Barbuda'],
  'arabia saudita': ['Asia/Riyadh', 'Arabia Saudita'],
  'argelia': ['Africa/Algiers', 'Argelia'],
  'argentina': ['America/Argentina/Buenos_Aires', 'Argentina'],
  'armenia': ['Asia/Yerevan', 'Armenia'],
  'australia': ['Australia/Sydney', 'Australia'],
  'austria': ['Europe/Vienna', 'Austria'],
  'azerbaiyan': ['Asia/Baku', 'Azerbaiyán'],
  'bahamas': ['America/Nassau', 'Bahamas'],
  'bangladesh': ['Asia/Dhaka', 'Bangladés'],
  'barbados': ['America/Barbados', 'Barbados'],
  'barein': ['Asia/Bahrain', 'Baréin'],
  'belgica': ['Europe/Brussels', 'Bélgica'],
  'belice': ['America/Belize', 'Belice'],
  'benin': ['Africa/Porto-Novo', 'Benín'],
  'bielorrusia': ['Europe/Minsk', 'Bielorrusia'],
  'bolivia': ['America/La_Paz', 'Bolivia'],
  'bosnia': ['Europe/Sarajevo', 'Bosnia'],
  'botsuana': ['Africa/Gaborone', 'Botsuana'],
  'brasil': ['America/Sao_Paulo', 'Brasil'],
  'brunei': ['Asia/Brunei', 'Brunéi'],
  'bulgaria': ['Europe/Sofia', 'Bulgaria'],
  'burkina faso': ['Africa/Ouagadougou', 'Burkina Faso'],
  'burundi': ['Africa/Bujumbura', 'Burundi'],
  'butan': ['Asia/Thimphu', 'Bután'],
  'cabo verde': ['Atlantic/Cape_Verde', 'Cabo Verde'],
  'camboya': ['Asia/Phnom_Penh', 'Camboya'],
  'camerun': ['Africa/Douala', 'Camerún'],
  'canada': ['America/Toronto', 'Canadá'],
  'catar': ['Asia/Qatar', 'Catar'],
  'chad': ['Africa/Ndjamena', 'Chad'],
  'chile': ['America/Santiago', 'Chile'],
  'china': ['Asia/Shanghai', 'China'],
  'chipre': ['Asia/Nicosia', 'Chipre'],
  'colombia': ['America/Bogota', 'Colombia'],
  'comoras': ['Indian/Comoro', 'Comoras'],
  'congo': ['Africa/Brazzaville', 'Congo'],
  'corea del norte': ['Asia/Pyongyang', 'Corea del Norte'],
  'corea del sur': ['Asia/Seoul', 'Corea del Sur'],
  'costa de marfil': ['Africa/Abidjan', 'Costa de Marfil'],
  'costa rica': ['America/Costa_Rica', 'Costa Rica'],
  'croacia': ['Europe/Zagreb', 'Croacia'],
  'cuba': ['America/Havana', 'Cuba'],
  'dinamarca': ['Europe/Copenhagen', 'Dinamarca'],
  'dominica': ['America/Dominica', 'Dominica'],
  'ecuador': ['America/Guayaquil', 'Ecuador'],
  'egipto': ['Africa/Cairo', 'Egipto'],
  'el salvador': ['America/El_Salvador', 'El Salvador'],
  'emiratos arabes': ['Asia/Dubai', 'Emiratos Árabes'],
  'eritrea': ['Africa/Asmara', 'Eritrea'],
  'eslovaquia': ['Europe/Bratislava', 'Eslovaquia'],
  'eslovenia': ['Europe/Ljubljana', 'Eslovenia'],
  'espana': ['Europe/Madrid', 'España'],
  'estados unidos': ['America/New_York', 'Estados Unidos'],
  'estonia': ['Europe/Tallinn', 'Estonia'],
  'etiopia': ['Africa/Addis_Ababa', 'Etiopía'],
  'filipinas': ['Asia/Manila', 'Filipinas'],
  'finlandia': ['Europe/Helsinki', 'Finlandia'],
  'fiyi': ['Pacific/Fiji', 'Fiyi'],
  'francia': ['Europe/Paris', 'Francia'],
  'gabon': ['Africa/Libreville', 'Gabón'],
  'gambia': ['Africa/Banjul', 'Gambia'],
  'georgia': ['Asia/Tbilisi', 'Georgia'],
  'ghana': ['Africa/Accra', 'Ghana'],
  'granada': ['America/Grenada', 'Granada'],
  'grecia': ['Europe/Athens', 'Grecia'],
  'guatemala': ['America/Guatemala', 'Guatemala'],
  'guinea': ['Africa/Conakry', 'Guinea'],
  'guinea ecuatorial': ['Africa/Malabo', 'Guinea Ecuatorial'],
  'guinea bisau': ['Africa/Bissau', 'Guinea Bisáu'],
  'guyana': ['America/Guyana', 'Guyana'],
  'haiti': ['America/Port-au-Prince', 'Haití'],
  'honduras': ['America/Tegucigalpa', 'Honduras'],
  'hungria': ['Europe/Budapest', 'Hungría'],
  'india': ['Asia/Kolkata', 'India'],
  'indonesia': ['Asia/Jakarta', 'Indonesia'],
  'irak': ['Asia/Baghdad', 'Irak'],
  'iran': ['Asia/Tehran', 'Irán'],
  'irlanda': ['Europe/Dublin', 'Irlanda'],
  'islandia': ['Atlantic/Reykjavik', 'Islandia'],
  'israel': ['Asia/Jerusalem', 'Israel'],
  'italia': ['Europe/Rome', 'Italia'],
  'jamaica': ['America/Jamaica', 'Jamaica'],
  'japon': ['Asia/Tokyo', 'Japón'],
  'jordania': ['Asia/Amman', 'Jordania'],
  'kazajistan': ['Asia/Almaty', 'Kazajistán'],
  'kenia': ['Africa/Nairobi', 'Kenia'],
  'kirguistan': ['Asia/Bishkek', 'Kirguistán'],
  'kuwait': ['Asia/Kuwait', 'Kuwait'],
  'laos': ['Asia/Vientiane', 'Laos'],
  'lesoto': ['Africa/Maseru', 'Lesoto'],
  'letonia': ['Europe/Riga', 'Letonia'],
  'libano': ['Asia/Beirut', 'Líbano'],
  'liberia': ['Africa/Monrovia', 'Liberia'],
  'libia': ['Africa/Tripoli', 'Libia'],
  'liechtenstein': ['Europe/Vaduz', 'Liechtenstein'],
  'lituania': ['Europe/Vilnius', 'Lituania'],
  'luxemburgo': ['Europe/Luxembourg', 'Luxemburgo'],
  'macedonia del norte': ['Europe/Skopje', 'Macedonia del Norte'],
  'madagascar': ['Indian/Antananarivo', 'Madagascar'],
  'malasia': ['Asia/Kuala_Lumpur', 'Malasia'],
  'malaui': ['Africa/Blantyre', 'Malaui'],
  'maldivas': ['Indian/Maldives', 'Maldivas'],
  'mali': ['Africa/Bamako', 'Malí'],
  'malta': ['Europe/Malta', 'Malta'],
  'marruecos': ['Africa/Casablanca', 'Marruecos'],
  'mauricio': ['Indian/Mauritius', 'Mauricio'],
  'mauritania': ['Africa/Nouakchott', 'Mauritania'],
  'mexico': ['America/Mexico_City', 'México'],
  'moldavia': ['Europe/Chisinau', 'Moldavia'],
  'monaco': ['Europe/Monaco', 'Mónaco'],
  'mongolia': ['Asia/Ulaanbaatar', 'Mongolia'],
  'montenegro': ['Europe/Podgorica', 'Montenegro'],
  'mozambique': ['Africa/Maputo', 'Mozambique'],
  'myanmar': ['Asia/Yangon', 'Myanmar'],
  'namibia': ['Africa/Windhoek', 'Namibia'],
  'nepal': ['Asia/Kathmandu', 'Nepal'],
  'nicaragua': ['America/Managua', 'Nicaragua'],
  'niger': ['Africa/Niamey', 'Níger'],
  'nigeria': ['Africa/Lagos', 'Nigeria'],
  'noruega': ['Europe/Oslo', 'Noruega'],
  'nueva zelanda': ['Pacific/Auckland', 'Nueva Zelanda'],
  'oman': ['Asia/Muscat', 'Omán'],
  'paises bajos': ['Europe/Amsterdam', 'Países Bajos'],
  'pakistan': ['Asia/Karachi', 'Pakistán'],
  'panama': ['America/Panama', 'Panamá'],
  'paraguay': ['America/Asuncion', 'Paraguay'],
  'peru': ['America/Lima', 'Perú'],
  'polonia': ['Europe/Warsaw', 'Polonia'],
  'portugal': ['Europe/Lisbon', 'Portugal'],
  'reino unido': ['Europe/London', 'Reino Unido'],
  'republica checa': ['Europe/Prague', 'República Checa'],
  'republica dominicana': ['America/Santo_Domingo', 'República Dominicana'],
  'ruanda': ['Africa/Kigali', 'Ruanda'],
  'rumania': ['Europe/Bucharest', 'Rumanía'],
  'rusia': ['Europe/Moscow', 'Rusia'],
  'samoa': ['Pacific/Apia', 'Samoa'],
  'san marino': ['Europe/San_Marino', 'San Marino'],
  'senegal': ['Africa/Dakar', 'Senegal'],
  'serbia': ['Europe/Belgrade', 'Serbia'],
  'seychelles': ['Indian/Mahe', 'Seychelles'],
  'sierra leona': ['Africa/Freetown', 'Sierra Leona'],
  'singapur': ['Asia/Singapore', 'Singapur'],
  'siria': ['Asia/Damascus', 'Siria'],
  'somalia': ['Africa/Mogadishu', 'Somalia'],
  'sri lanka': ['Asia/Colombo', 'Sri Lanka'],
  'sudafrica': ['Africa/Johannesburg', 'Sudáfrica'],
  'sudan': ['Africa/Khartoum', 'Sudán'],
  'suecia': ['Europe/Stockholm', 'Suecia'],
  'suiza': ['Europe/Zurich', 'Suiza'],
  'surinam': ['America/Paramaribo', 'Surinam'],
  'tailandia': ['Asia/Bangkok', 'Tailandia'],
  'taiwan': ['Asia/Taipei', 'Taiwán'],
  'tanzania': ['Africa/Dar_es_Salaam', 'Tanzania'],
  'tayikistan': ['Asia/Dushanbe', 'Tayikistán'],
  'togo': ['Africa/Lome', 'Togo'],
  'trinidad y tobago': ['America/Port_of_Spain', 'Trinidad y Tobago'],
  'tunez': ['Africa/Tunis', 'Túnez'],
  'turkmenistan': ['Asia/Ashgabat', 'Turkmenistán'],
  'turquia': ['Europe/Istanbul', 'Turquía'],
  'ucrania': ['Europe/Kiev', 'Ucrania'],
  'uganda': ['Africa/Kampala', 'Uganda'],
  'uruguay': ['America/Montevideo', 'Uruguay'],
  'uzbekistan': ['Asia/Tashkent', 'Uzbekistán'],
  'vaticano': ['Europe/Vatican', 'Vaticano'],
  'venezuela': ['America/Caracas', 'Venezuela'],
  'vietnam': ['Asia/Ho_Chi_Minh', 'Vietnam'],
  'yemen': ['Asia/Aden', 'Yemen'],
  'yibuti': ['Africa/Djibouti', 'Yibuti'],
  'zambia': ['Africa/Lusaka', 'Zambia'],
  'zimbabue': ['Africa/Harare', 'Zimbabue'],
};
// Alias comunes
PAISES['eeuu'] = PAISES['estados unidos'];
PAISES['usa'] = PAISES['estados unidos'];
PAISES['inglaterra'] = PAISES['reino unido'];
PAISES['holanda'] = PAISES['paises bajos'];
PAISES['birmania'] = PAISES['myanmar'];
PAISES['chequia'] = PAISES['republica checa'];

function horaEn(tz) {
  return new Date().toLocaleTimeString('es-ES', { timeZone: tz, hour: '2-digit', minute: '2-digit' });
}
// ----------------------------------------------------------------------------

// Chats esperando que les digan un país (jid -> expiración)
const esperandoPais = new Map();

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
      reply = '📋 Comandos:\n• */hola* - Saludar\n• */hora* - Te pregunta de qué país quieres la hora\n• */ayuda* - Este mensaje';
    } else if (text === '/hora') {
      esperandoPais.set(from, Date.now() + 60000);
      reply = '🌍 ¿De qué país quieres saber la hora? Escríbelo así: */mexico*, */argentina*, */espana*...';
    } else if (text.startsWith('/hora ')) {
      const pais = normalizar(text.slice(6).trim());
      const info = PAISES[pais];
      reply = info
        ? `🕐 En ${info[1]} son las ${horaEn(info[0])}`
        : '😅 No encontré ese país. Escribe */hora* e intenta de nuevo.';
    } else if (text.startsWith('/')) {
      // /pais solo responde si antes se pidió /hora (vale por 1 minuto)
      const pais = normalizar(text.slice(1).trim());
      const info = PAISES[pais];
      if (info) {
        const exp = esperandoPais.get(from);
        if (exp && Date.now() < exp) {
          reply = `🕐 En ${info[1]} son las ${horaEn(info[0])}`;
        }
      }
    }

    if (reply) await sock.sendMessage(from, { text: reply });
  });

  // Dar la bienvenida cuando alguien se une al grupo
  sock.ev.on('group-participants.update', async ({ id, participants, action }) => {
    try {
      if (action !== 'add') return;
      if (nombresGrupos[id] !== GRUPO_BIENVENIDA) return;
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
