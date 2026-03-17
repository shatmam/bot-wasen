require('dotenv').config();
const { ImapFlow } = require("imapflow");
const { simpleParser } = require('mailparser');
const { google } = require("googleapis");
const fetch = require("node-fetch");

const ADMIN_PHONE = process.env.ADMIN_PHONE; 
const WA_TOKEN = process.env.WA_TOKEN;
const RECHECK_TIME = 1 * 60 * 1000; 

const correosProcesados = new Set();
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
            await enviarWA(ADMIN_PHONE, `🚀 *SISTEMA REPARADO*\nEscaneando correos...`);
            botIniciado = true;
        }

        let list = await client.search({ from: "netflix" });
        let ultimos = list.slice(-3).reverse(); 

        for (let seq of ultimos) {
            if (correosProcesados.has(seq)) continue;

            let msg = await client.fetchOne(seq, { source: true, envelope: true });
            let parsed = await simpleParser(msg.source);
            let html = parsed.html || "";
            // Limpieza de texto para detectar perfil mejor
            let text = (parsed.text || "").replace(/\r?\n|\r/g, " "); 
            let correoCuenta = (msg.envelope.to[0].address || "").toLowerCase().trim();

            // 1. MEJORADO: Captura de Perfil (Busca "Solicitud de" o "Hola, [nombre]:")
            let perfilDelCorreo = "DESCONOCIDO";
            const matchSolicitud = text.match(/Solicitud de\s+([^\s,]+)/i);
            const matchHola = text.match(/Hola,\s*([^:]+):/i);
            
            if (matchSolicitud) perfilDelCorreo = matchSolicitud[1].trim();
            else if (matchHola) perfilDelCorreo = matchHola[1].trim();

            // 2. MEJORADO: Captura de Link (Rastreo de botón de Netflix)
            // Esta regex busca URLs que contengan 'update-home' o 'confirm-account' ignorando caracteres de escape
            const regexLink = /https?:\/\/(?:www\.)?netflix\.com\/[^\s"<>]+(?:update-home|confirm-account|nm_hp)[^\s"<>]+/gi;
            const links = html.match(regexLink) || text.match(regexLink);
            const elLink = links ? links[0].replace(/&amp;/g, '&') : null;

            // Reporte al Admin
            await enviarWA(ADMIN_PHONE, `📩 *ANALIZANDO*\n📧 Cuenta: ${correoCuenta}\n👤 Perfil: "${perfilDelCorreo}"\n🔗 Link: ${elLink ? "✅ ENCONTRADO" : "❌ NO ENCONTRADO"}`);

            if (elLink && perfilDelCorreo !== "DESCONOCIDO") {
                const cliente = clientes.find(c => 
                    (c[4] || "").toLowerCase().trim() === correoCuenta && 
                    (c[6] || "").toLowerCase().trim() === perfilDelCorreo.toLowerCase()
                );

                if (cliente) {
                    await enviarWA(cliente[2], `🏠 *ACTIVA TU TV*\n\nHola *${cliente[1]}*, dale clic aquí para actualizar tu Hogar:\n${elLink}`);
                    await enviarWA(ADMIN_PHONE, `✅ *ENVIADO*: ${cliente[1]} (${perfilDelCorreo})`);
                } else {
                    await enviarWA(ADMIN_PHONE, `⚠️ *SIN REGISTRO*: No encontré el perfil "${perfilDelCorreo}" para la cuenta ${correoCuenta} en tu Excel.`);
                }
            }
            correosProcesados.add(seq);
        }
        await client.logout();
    } catch (e) {
        if (client) await client.logout().catch(() => {});
    }
}

procesarCorreos();
setInterval(procesarCorreos, RECHECK_TIME);
