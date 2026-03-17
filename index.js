require('dotenv').config();
const { ImapFlow } = require("imapflow");
const { simpleParser } = require('mailparser');
const { google } = require("googleapis");
const fetch = require("node-fetch");

const ADMIN_PHONE = process.env.ADMIN_PHONE; 
const WA_TOKEN = process.env.WA_TOKEN;
const RECHECK_TIME = 1 * 60 * 1000; // 1 minuto

const correosProcesados = new Set();
let botIniciado = false;

// Limpieza de perfil para comparar con la Columna G del Excel
function limpiarPerfil(texto) {
    if (!texto) return "";
    return texto.replace(/Solicitud de/i, "").trim().toLowerCase();
}

async function enviarWA(tel, msj) {
    try {
        let numero = tel.toString().replace(/[^0-9]/g, "");
        if (!numero.startsWith("1") && numero.length === 10) numero = "1" + numero;
        await fetch("https://www.wasenderapi.com/api/send-message", {
            method: "POST",
            headers: { "Authorization": `Bearer ${WA_TOKEN}`, "Content-Type": "application/json" },
            body: JSON.stringify({ to: "+" + numero, text: msj })
        });
    } catch (e) { console.log("❌ Error WA:", e.message); }
}

async function procesarCorreos() {
    const client = new ImapFlow({
        host: "imap.gmail.com", port: 993, secure: true,
        auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
        logger: false, tls: { rejectUnauthorized: false }
    });

    try {
        await client.connect();
        await client.mailboxOpen('INBOX');

        // Cargar Base de Datos de Google Sheets
        const auth = new google.auth.GoogleAuth({
            credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
            scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"]
        });
        const sheets = google.sheets({ version: "v4", auth });
        const spreadsheet = await sheets.spreadsheets.values.get({ 
            spreadsheetId: process.env.SPREADSHEET_ID, 
            range: "Clientes!A2:K1000" 
        });
        const todosLosClientes = spreadsheet.data.values || [];

        if (!botIniciado) {
            await enviarWA(ADMIN_PHONE, `📡 *BOT DE FILTRADO ACTIVO*\nBuscando correos de Hogar y Acceso Temporal.`);
            botIniciado = true;
        }

        // Buscar correos NO LEÍDOS de Netflix
        let list = await client.search({ seen: false, from: "netflix" });

        for (let seq of list) {
            if (correosProcesados.has(seq)) continue;

            let msg = await client.fetchOne(seq, { source: true, envelope: true });
            let parsed = await simpleParser(msg.source);
            let subject = (parsed.subject || "").toLowerCase();
            let htmlOriginal = parsed.html || "";
            let text = (parsed.text || "").replace(/\s+/g, ' '); 
            let correoCuenta = (msg.envelope.to[0].address || "").toLowerCase().trim();

            // FILTRO: Solo procesar si es Hogar o Acceso Temporal
            const esHogar = subject.includes("hogar") || text.includes("hogar");
            const esTemporal = subject.includes("temporal") || text.includes("código de acceso") || text.includes("pin-code");

            if (esHogar || esTemporal) {
                // 1. Extraer el Enlace (href)
                const linkMatch = htmlOriginal.match(/href="([^"]*update-home[^"]*)"/) || 
                                  htmlOriginal.match(/href="([^"]*pin-code[^"]*)"/) || 
                                  htmlOriginal.match(/href="([^"]*confirm-account[^"]*)"/);
                
                let elLink = linkMatch ? linkMatch[1].replace(/&amp;/g, "&") : null;

                // 2. Identificar el Perfil (Solicitud de...)
                const matchPerfil = text.match(/Solicitud de ([^ ]+)/i) || text.match(/Hola, ([^:]+):/i);
                let perfilNombre = matchPerfil ? matchPerfil[1].trim() : "Desconocido";

                if (elLink) {
                    const perfilBusqueda = limpiarPerfil(perfilNombre);

                    // 3. Buscar en el Excel (Doble Filtro: Correo + Perfil)
                    const cliente = todosLosClientes.find(fila => {
                        let correoFila = (fila[4] || "").toLowerCase().trim();
                        let perfilFila = limpiarPerfil(fila[6] || "");
                        return correoFila === correoCuenta && perfilFila === perfilBusqueda;
                    });

                    if (cliente) {
                        const tipo = esTemporal ? "ACCESO TEMPORAL" : "ACTUALIZACIÓN DE HOGAR";
                        const mensaje = `📺 *SOLICITUD DE ${tipo}*\n\nHola *${cliente[1]}*, detectamos tu solicitud para el perfil *${perfilNombre}*.\n\nPulsa el siguiente enlace para activar tu TV:\n${elLink}`;
                        
                        await enviarWA(cliente[2], mensaje);
                        
                        // Informar al Admin
                        await enviarWA(ADMIN_PHONE, `✅ *ENVIADO*: ${cliente[1]} (${perfilNombre})\n📧 Cuenta: ${correoCuenta}\n📌 Tipo: ${tipo}`);
                    } else {
                        // Informar al Admin si no hay coincidencia
                        await enviarWA(ADMIN_PHONE, `⚠️ *CLIENTE NO ENCONTRADO*\n📧 Cuenta: ${correoCuenta}\n👤 Perfil: ${perfilNombre}\n❌ No está registrado en el Excel.`);
                    }
                }
            }
            correosProcesados.add(seq);
            // Marcar como leído para no repetir en la siguiente vuelta
            await client.messageFlagsAdd(seq, ['\\Seen']);
        }
        await client.logout();
    } catch (e) { if (client) await client.logout().catch(() => {}); }
}

procesarCorreos();
setInterval(procesarCorreos, RECHECK_TIME);
