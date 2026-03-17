require('dotenv').config();
const { ImapFlow } = require("imapflow");
const { simpleParser } = require('mailparser');
const { google } = require("googleapis");
const fetch = require("node-fetch");

const ADMIN_PHONE = process.env.ADMIN_PHONE; 
const WA_TOKEN = process.env.WA_TOKEN;
const RECHECK_TIME = 1 * 60 * 1000; 

const correosProcesados = new Set();
// Mapa para rastrear el último envío por (Cuenta + Perfil) y evitar spam
const ultimosEnvios = new Map(); 

async function enviarWA(tel, msj, btnLink = null) {
    try {
        let numero = tel.toString().replace(/[^0-9]/g, "");
        if (!numero.startsWith("1") && numero.length === 10) numero = "1" + numero;

        // Estructura compatible con botones de la mayoría de APIs de WA
        const payload = {
            to: "+" + numero,
            text: msj
        };

        if (btnLink) {
            payload.buttons = [
                {
                    type: "url",
                    display: "✅ ACTIVAR TV",
                    url: btnLink
                }
            ];
        }

        await fetch("https://www.wasenderapi.com/api/send-message", {
            method: "POST",
            headers: { "Authorization": `Bearer ${WA_TOKEN}`, "Content-Type": "application/json" },
            body: JSON.stringify(payload)
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

        const auth = new google.auth.GoogleAuth({
            credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
            scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"]
        });
        const sheets = google.sheets({ version: "v4", auth });
        const spreadsheet = await sheets.spreadsheets.values.get({ 
            spreadsheetId: process.env.SPREADSHEET_ID, 
            range: "Clientes!A2:K1000" 
        });
        const clientesExcel = spreadsheet.data.values || [];

        // Buscamos todos los correos de Netflix
        let list = await client.search({ from: "netflix" });
        
        // Revisamos los últimos 15 correos para que no se escape nada
        for (let seq of list.slice(-15).reverse()) {
            let meta = await client.fetchOne(seq, { envelope: true });
            let uid = meta.envelope.messageId;

            if (correosProcesados.has(uid)) continue;

            let msg = await client.fetchOne(seq, { source: true });
            let parsed = await simpleParser(msg.source);
            let htmlOriginal = parsed.html || parsed.textAsHtml || "";
            let text = (parsed.text || "").replace(/\s+/g, ' '); 
            let correoCuenta = (meta.envelope.to[0].address || "").toLowerCase().trim();

            // 1. RECONOCIMIENTO DEL LINK (Agregado el patrón primary-location que me pasaste)
            const linkMatch = htmlOriginal.match(/href="([^"]*update-primary-location[^"]*)"/) || 
                              htmlOriginal.match(/href="([^"]*update-home[^"]*)"/) || 
                              htmlOriginal.match(/href="([^"]*confirm-account[^"]*)"/) ||
                              htmlOriginal.match(/href="([^"]*netflix.com\/browse[^"]*)"/);
            
            const elLink = linkMatch ? linkMatch[1].replace(/&amp;/g, "&") : null;

            // 2. EXTRACCIÓN DE PERFIL
            const matchSolicitud = text.match(/Solicitud de\s+([a-zA-Z0-9áéíóúÁÉÍÓÚñÑ ]+)/i);
            const matchHola = text.match(/Hola,\s*([^:]+):/i);
            let perfilCorreo = matchSolicitud ? matchSolicitud[1].trim() : (matchHola ? matchHola[1].trim() : "DESCONOCIDO");

            if (elLink && perfilCorreo !== "DESCONOCIDO") {
                const perfilBusqueda = perfilCorreo.toLowerCase().trim();
                const llaveAntiSpam = `${correoCuenta}-${perfilBusqueda}`;
                const ahora = Date.now();

                // Evita enviar exactamente lo mismo al mismo perfil en menos de 2 minutos
                if (ultimosEnvios.has(llaveAntiSpam) && (ahora - ultimosEnvios.get(llaveAntiSpam) < 120000)) {
                    correosProcesados.add(uid);
                    continue;
                }

                // BUSCAMOS EN EL EXCEL: Coincidencia de Correo (Col E) Y Perfil (Col G)
                const coincidencias = clientesExcel.filter(c => 
                    (c[4] || "").toLowerCase().trim() === correoCuenta && 
                    (c[6] || "").toLowerCase().trim() === perfilBusqueda
                );

                if (coincidencias.length > 0) {
                    for (let cliente of coincidencias) {
                        const textoMsj = `🏠 *NETFLIX: ACTUALIZACIÓN*\n\nHola *${cliente[1]}*, recibimos una solicitud para el perfil *${perfilCorreo}*.\n\nPulsa el botón de abajo para activar:`;
                        await enviarWA(cliente[2], textoMsj, elLink);
                    }
                    await enviarWA(ADMIN_PHONE, `✅ *BOTÓN ENVIADO*: Perfil "${perfilCorreo}" (${correoCuenta})`);
                    ultimosEnvios.set(llaveAntiSpam, ahora);
                } else {
                    // Si no hay match, te aviso para que revises el nombre en el Excel
                    await enviarWA(ADMIN_PHONE, `⚠️ *PERFIL NO ENCONTRADO*: "${perfilCorreo}" en cuenta ${correoCuenta}.`);
                }
                correosProcesados.add(uid);
            }
        }
        await client.logout();
    } catch (e) {
        if (client) await client.logout().catch(() => {});
    }
}

procesarCorreos();
setInterval(procesarCorreos, RECHECK_TIME);
