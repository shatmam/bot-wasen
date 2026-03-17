require('dotenv').config();
const { ImapFlow } = require("imapflow");
const { simpleParser } = require('mailparser');
const { google } = require("googleapis");
const fetch = require("node-fetch");

const ADMIN_PHONE = process.env.ADMIN_PHONE; 
const WA_TOKEN = process.env.WA_TOKEN;
const RECHECK_TIME = 5 * 60 * 1000; 

let botIniciado = false;
const correosProcesados = new Set();

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
            await enviarWA(ADMIN_PHONE, `🕵️ *BOT ACTIVO*\nPriorizando "Solicitud de" (Abajo).\nRevisando cada 5 min.`);
            botIniciado = true;
        }

        let list = await client.search({ from: "netflix" });
        let ultimos = list.slice(-5);

        for (let seq of ultimos) {
            if (correosProcesados.has(seq)) continue;

            let msg = await client.fetchOne(seq, { source: true, envelope: true });
            let parsed = await simpleParser(msg.source);
            let text = (parsed.text || "").replace(/\s+/g, ' '); 
            let html = parsed.html || "";
            let correoCuenta = (msg.envelope.to[0].address || "").toLowerCase().trim();

            // 🎯 LÓGICA DE PRIORIDAD:
            // Buscamos primero "Solicitud de X" (que es lo que está abajo en el cuadro)
            const matchSolicitud = text.match(/Solicitud de\s+([a-zA-Z0-9áéíóúÁÉÍÓÚñÑ]+)/i);
            // Si no existe, buscamos el "Hola, X:"
            const matchHola = text.match(/Hola,\s*([^:]+):/i);
            
            let perfilDelCorreo = "no detectado";
            if (matchSolicitud) {
                perfilDelCorreo = matchSolicitud[1].trim().toLowerCase();
            } else if (matchHola) {
                perfilDelCorreo = matchHola[1].trim().toLowerCase();
            }

            const regexLink = /https:\/\/www\.netflix\.com\/[^\s"<>]+(?:confirm-account|update-home)[^\s"<>]+/gi;
            const links = html.match(regexLink) || text.match(regexLink);

            if (links && perfilDelCorreo !== "no detectado") {
                const elLink = links[0];
                const cliente = clientes.find(c => 
                    (c[4] || "").toLowerCase().trim() === correoCuenta && 
                    (c[6] || "").toLowerCase().trim() === perfilDelCorreo
                );

                if (cliente) {
                    await enviarWA(cliente[2], `🏠 *SOLICITUD NETFLIX*\n\nHola *${cliente[1]}*, detectamos tu solicitud en el perfil *${perfilDelCorreo.toUpperCase()}*.\n\nActiva tu TV aquí:\n${elLink}`);
                    await enviarWA(ADMIN_PHONE, `✅ *PROCESADO*: ${correoCuenta} (Perfil ${perfilDelCorreo})`);
                    correosProcesados.add(seq);
                } else {
                    // Si detecta perfil pero no está en Excel, te avisa a ti una sola vez
                    await enviarWA(ADMIN_PHONE, `⚠️ *SIN DUEÑO*: Perfil "${perfilDelCorreo}" en ${correoCuenta}.`);
                    correosProcesados.add(seq); 
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
