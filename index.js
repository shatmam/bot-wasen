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
            await enviarWA(ADMIN_PHONE, `📡 *AUDITORÍA ACTIVA*\nClientes: ${clientes.length}\nRevisando últimos 3 de Netflix...`);
            botIniciado = true;
        }

        let list = await client.search({ from: "netflix" });
        let ultimos = list.slice(-3); 

        for (let seq of ultimos) {
            if (correosProcesados.has(seq)) continue;

            let msg = await client.fetchOne(seq, { source: true, envelope: true });
            let parsed = await simpleParser(msg.source);
            let text = (parsed.text || "").replace(/\s+/g, ' '); 
            let html = parsed.html || "";
            let correoCuenta = (msg.envelope.to[0].address || "").toLowerCase().trim();

            // 🔍 EXTRACCIÓN AGRESIVA DE PERFIL
            const matchSolicitud = text.match(/Solicitud de\s+([a-zA-Z0-9áéíóúÁÉÍÓÚñÑ]+)/i);
            const matchHola = text.match(/Hola,\s*([^:]+):/i);
            let perfilDelCorreo = matchSolicitud ? matchSolicitud[1].trim() : (matchHola ? matchHola[1].trim() : "DESCONOCIDO");

            // 🔗 EXTRACCIÓN DE LINK
            const regexLink = /https:\/\/www\.netflix\.com\/[^\s"<>]+(?:confirm-account|update-home)[^\s"<>]+/gi;
            const links = html.match(regexLink) || text.match(regexLink);
            const elLink = links ? links[0] : null;

            // 📢 NOTIFICACIÓN OBLIGATORIA AL ADMIN
            let reporte = `📩 *CORREO DETECTADO*\n📧 Cuenta: ${correoCuenta}\n👤 Perfil: "${perfilDelCorreo}"\n🔗 Link: ${elLink ? "✅ OK" : "❌ NO ENCONTRADO"}`;
            await enviarWA(ADMIN_PHONE, reporte);

            if (elLink && perfilDelCorreo !== "DESCONOCIDO") {
                const cliente = clientes.find(c => 
                    (c[4] || "").toLowerCase().trim() === correoCuenta && 
                    (c[6] || "").toLowerCase().trim() === perfilDelCorreo.toLowerCase()
                );

                if (cliente) {
                    await enviarWA(cliente[2], `🏠 *ACTIVA TU TV*\n\nHola *${cliente[1]}*, dale clic aquí:\n${elLink}`);
                    await enviarWA(ADMIN_PHONE, `✅ *ENVIADO A*: ${cliente[1]}`);
                } else {
                    await enviarWA(ADMIN_PHONE, `⚠️ *SIN DUEÑO*: Revisa que en el Excel diga "${perfilDelCorreo}" en la columna G para ${correoCuenta}`);
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
