require('dotenv').config();
const { ImapFlow } = require("imapflow");
const { simpleParser } = require('mailparser');
const { google } = require("googleapis");
const fetch = require("node-fetch");

const ADMIN_PHONE = process.env.ADMIN_PHONE; 
const WA_TOKEN = process.env.WA_TOKEN;
const RECHECK_TIME = 1 * 60 * 1000; 

// Candado para no repetir correos en la misma sesión
const idsProcesados = new Set();
let botIniciado = false;

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

        const auth = new google.auth.GoogleAuth({
            credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
            scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"]
        });
        const sheets = google.sheets({ version: "v4", auth });
        const spreadsheet = await sheets.spreadsheets.values.get({ 
            spreadsheetId: process.env.SPREADSHEET_ID, 
            range: "Clientes!A2:K1000" 
        });
        const clientes = spreadsheet.data.values || [];

        if (!botIniciado) {
            await enviarWA(ADMIN_PHONE, `✅ *FILTRO ANTI-REPETICIÓN ACTIVO*\nBuscando perfiles exactos y links de acceso.`);
            botIniciado = true;
        }

        // Buscamos correos de Netflix
        let list = await client.search({ from: "netflix" });

        for (let seq of list.slice(-10).reverse()) {
            // Obtener el ID único del mensaje para no repetir
            let meta = await client.fetchOne(seq, { envelope: true });
            let uid = meta.envelope.messageId;

            if (idsProcesados.has(uid)) continue;

            let msg = await client.fetchOne(seq, { source: true });
            let parsed = await simpleParser(msg.source);
            let htmlOriginal = parsed.html || "";
            let text = (parsed.text || "").replace(/\s+/g, ' '); 
            let correoCuenta = (meta.envelope.to[0].address || "").toLowerCase().trim();

            // 1. Extraer Link (Hogar o Temporal)
            const linkMatch = htmlOriginal.match(/href="([^"]*update-home[^"]*)"/) || 
                              htmlOriginal.match(/href="([^"]*pin-code[^"]*)"/) || 
                              htmlOriginal.match(/href="([^"]*confirm-account[^"]*)"/);
            
            const elLink = linkMatch ? linkMatch[1].replace(/&amp;/g, "&") : null;

            // 2. Extraer Perfil con Prioridad Alta
            // Primero busca "Solicitud de [Nombre]" porque es el más exacto
            const matchSolicitud = text.match(/Solicitud de\s+([a-zA-Z0-9áéíóúÁÉÍÓÚñÑ]+)/i);
            const matchHola = text.match(/Hola,\s*([^:]+):/i);
            
            let perfilFinal = "DESCONOCIDO";
            if (matchSolicitud) {
                perfilFinal = matchSolicitud[1].trim();
            } else if (matchHola) {
                perfilFinal = matchHola[1].trim();
            }

            if (elLink && perfilFinal !== "DESCONOCIDO") {
                // Buscamos coincidencia exacta en Excel
                const cliente = clientes.find(c => 
                    (c[4] || "").toLowerCase().trim() === correoCuenta && 
                    (c[6] || "").toLowerCase().trim() === perfilFinal.toLowerCase()
                );

                if (cliente) {
                    const esTemporal = elLink.includes("pin-code");
                    const mensaje = `📺 *ACCESO NETFLIX*\n\nHola *${cliente[1]}*, detectamos tu solicitud para el perfil *${perfilFinal}*.\n\nPulsa el botón para activar:\n${elLink}`;
                    
                    await enviarWA(cliente[2], mensaje);
                    await enviarWA(ADMIN_PHONE, `✅ *ENVIADO*: ${cliente[1]} (${perfilFinal})\n📧 ${correoCuenta}`);
                    
                    // Marcar como procesado con el ID único
                    idsProcesados.add(uid);
                } else {
                    // Solo avisar al admin si no se encuentra el perfil para no spammerar
                    console.log(`Perfil ${perfilFinal} no encontrado en cuenta ${correoCuenta}`);
                }
            }
        }
        await client.logout();
    } catch (e) {
        if (client) await client.logout().catch(() => {});
    }
}

procesarCorreos();
setInterval(procesarCorreos, RECHECK_TIME);
