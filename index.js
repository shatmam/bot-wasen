require('dotenv').config();
const { ImapFlow } = require("imapflow");
const { simpleParser } = require('mailparser');
const { google } = require("googleapis");
const fetch = require("node-fetch");

const EMAIL_USER = process.env.EMAIL_USER; 
const EMAIL_PASS = process.env.EMAIL_PASS; 
const SPREADSHEET_ID = process.env.SPREADSHEET_ID; 
const WA_TOKEN = process.env.WA_TOKEN; 
const ADMIN_PHONE = process.env.ADMIN_PHONE; 
const RECHECK_TIME = 15 * 1000; // 🚀 Revisión cada 15 segundos

let botIniciado = false;

async function enviarWA(tel, msj) {
    try {
        let numero = tel.toString().replace(/[^0-9]/g, "");
        if (!numero.startsWith("1") && numero.length === 10) numero = "1" + numero;
        await fetch("https://www.wasenderapi.com/api/send-message", {
            method: "POST",
            headers: { "Authorization": `Bearer ${WA_TOKEN}`, "Content-Type": "application/json" },
            body: JSON.stringify({ to: numero, text: msj })
        });
    } catch (e) { console.log("❌ Error WA:", e.message); }
}

async function procesarCorreos() {
    console.log("⚡ Escaneando...");
    const client = new ImapFlow({
        host: "imap.gmail.com", port: 993, secure: true,
        auth: { user: EMAIL_USER, pass: EMAIL_PASS },
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
            spreadsheetId: SPREADSHEET_ID, 
            range: "Clientes!A2:K1000" 
        });
        const clientes = spreadsheet.data.values || [];

        if (!botIniciado) {
            await enviarWA(ADMIN_PHONE, `🚀 *BOT ACTIVO (MODO RÁPIDO)*\nComparando Correo + Perfil (Col. G)\nFrecuencia: 15 seg.`);
            botIniciado = true;
        }

        let list = await client.search({ from: "netflix", unseen: true });

        for (let seq of list) {
            let msg = await client.fetchOne(seq, { source: true, envelope: true });
            let parsed = await simpleParser(msg.source);
            
            // Extraemos texto y HTML
            let contenido = (parsed.text || "").toLowerCase();
            let html = parsed.html || parsed.textAsHtml || "";
            let correoCuenta = (msg.envelope.to[0].address || "").toLowerCase().trim();

            // --- LÓGICA DE DETECCIÓN DE PERFIL ---
            // Captura cualquier cosa después de "solicitud de" hasta encontrar una coma o salto de línea
            const perfilMatch = contenido.match(/solicitud de\s+([^\n,]+)/i);
            let perfilDelCorreo = perfilMatch ? perfilMatch[1].trim().toLowerCase() : null;

            if (perfilDelCorreo) {
                // Buscamos en el Excel: Correo (Col E / c[4]) y Perfil (Col G / c[6])
                const clienteCorrecto = clientes.find(c => 
                    (c[4] || "").toLowerCase().trim() === correoCuenta && 
                    (c[6] || "").toLowerCase().trim() === perfilDelCorreo
                );

                if (clienteCorrecto) {
                    const linkMatch = html.match(/href="([^"]*update-home[^"]*)"/) || 
                                     html.match(/href="([^"]*confirm-account[^"]*)"/);

                    if (linkMatch) {
                        const elLink = linkMatch[1];
                        const msj = `🏠 *ACTUALIZACIÓN NETFLIX*\n\n` +
                                   `Hola *${clienteCorrecto[1]}*, detectamos tu solicitud para el perfil: *${perfilDelCorreo.toUpperCase()}*.\n\n` +
                                   `Haz clic aquí para activar:\n${elLink}`;
                        
                        await enviarWA(clienteCorrecto[2], msj);
                        await enviarWA(ADMIN_PHONE, `✅ *ENVIADO*: ${clienteCorrecto[1]} (Perfil: ${perfilDelCorreo})`);
                    }
                } else {
                    await enviarWA(ADMIN_PHONE, `⚠️ *SIN DUEÑO*: Perfil "${perfilDelCorreo}" en cuenta ${correoCuenta} no existe en Excel.`);
                }
            }
            await client.messageFlagsAdd(seq, ['\\Seen']);
        }
        await client.logout();
    } catch (e) {
        if (client) await client.logout().catch(() => {});
    }
}

procesarCorreos();
setInterval(procesarCorreos, RECHECK_TIME);
