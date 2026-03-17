require('dotenv').config();
const { ImapFlow } = require("imapflow");
const { simpleParser } = require('mailparser');
const { google } = require("googleapis");
const fetch = require("node-fetch");

const ADMIN_PHONE = process.env.ADMIN_PHONE; 
const WA_TOKEN = process.env.WA_TOKEN;
const RECHECK_TIME = 1 * 60 * 1000; 

// Este Set guarda los IDs de los correos ya enviados para no repetir
const idsEnviados = new Set();
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
            await enviarWA(ADMIN_PHONE, `🚀 *BOT ACTIVO (MODO ESCANEO TOTAL)*\nRevisando correos leídos y no leídos.\nClientes en base: ${clientes.length}`);
            botIniciado = true;
        }

        // Buscamos los correos de Netflix (sin filtro de "no leídos")
        let list = await client.search({ from: "netflix" });

        // Revisamos los últimos 10 para cubrir cualquier solicitud reciente
        for (let seq of list.slice(-10).reverse()) {
            let meta = await client.fetchOne(seq, { envelope: true });
            let uid = meta.envelope.messageId; // ID único del correo

            // Si este correo ya lo enviamos en esta sesión, lo saltamos
            if (idsEnviados.has(uid)) continue;

            let msg = await client.fetchOne(seq, { source: true });
            let parsed = await simpleParser(msg.source);
            let htmlOriginal = parsed.html || "";
            let text = (parsed.text || "").replace(/\s+/g, ' '); 
            let correoCuenta = (meta.envelope.to[0].address || "").toLowerCase().trim();

            // 1. Extraer Link (Hogar o PIN)
            const linkMatch = htmlOriginal.match(/href="([^"]*update-home[^"]*)"/) || 
                              htmlOriginal.match(/href="([^"]*pin-code[^"]*)"/) || 
                              htmlOriginal.match(/href="([^"]*confirm-account[^"]*)"/);
            
            const elLink = linkMatch ? linkMatch[1].replace(/&amp;/g, "&") : null;

            // 2. Extraer Perfil del SOLICITANTE
            const matchSolicitud = text.match(/Solicitud de\s+([a-zA-Z0-9áéíóúÁÉÍÓÚñÑ]+)/i);
            const matchHola = text.match(/Hola,\s*([^:]+):/i);
            
            let perfilFinal = "DESCONOCIDO";
            if (matchSolicitud) {
                perfilFinal = matchSolicitud[1].trim();
            } else if (matchHola) {
                perfilFinal = matchHola[1].trim();
            }

            if (elLink && perfilFinal !== "DESCONOCIDO") {
                // Buscamos al cliente en el Excel (Correo + Perfil exacto)
                const cliente = clientes.find(c => 
                    (c[4] || "").toLowerCase().trim() === correoCuenta && 
                    (c[6] || "").toLowerCase().trim() === perfilFinal.toLowerCase()
                );

                if (cliente) {
                    const tipo = elLink.includes("pin-code") ? "CÓDIGO TEMPORAL" : "ACTUALIZACIÓN HOGAR";
                    const mensaje = `📺 *SOLICITUD ${tipo}*\n\nHola *${cliente[1]}*, detectamos tu solicitud para el perfil *${perfilFinal}*.\n\nPulsa aquí para activar:\n${elLink}`;
                    
                    await enviarWA(cliente[2], mensaje);
                    await enviarWA(ADMIN_PHONE, `✅ *ENVIADO*: ${cliente[1]} (${perfilFinal}) - ${tipo}`);
                    
                    // Guardamos el ID para no volver a enviarlo jamás
                    idsEnviados.add(uid);
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
