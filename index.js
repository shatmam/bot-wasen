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
            await enviarWA(ADMIN_PHONE, `📡 *MODO EXTRACCIÓN TOTAL ACTIVO*`);
            botIniciado = true;
        }

        let list = await client.search({ from: "netflix" });
        let ultimos = list.slice(-3).reverse(); 

        for (let seq of ultimos) {
            if (correosProcesados.has(seq)) continue;

            let msg = await client.fetchOne(seq, { source: true, envelope: true });
            let parsed = await simpleParser(msg.source);
            let html = parsed.html || "";
            let text = (parsed.text || "").replace(/\s+/g, " "); 
            let correoCuenta = (msg.envelope.to[0].address || "").toLowerCase().trim();

            // 1. Extraer Perfil (Búsqueda multizona)
            let perfilDelCorreo = "DESCONOCIDO";
            const matchSolicitud = text.match(/Solicitud de\s+([^\s,:]+)/i);
            const matchHola = text.match(/Hola,\s*([^:]+):/i);
            if (matchSolicitud) perfilDelCorreo = matchSolicitud[1].trim();
            else if (matchHola) perfilDelCorreo = matchHola[1].trim();

            // 2. BUSCADOR AGRESIVO DE LINKS
            // Buscamos cualquier link que contenga palabras clave de Netflix
            const linksEncontrados = html.match(/https?:\/\/[^"'>\s]+/g) || [];
            let elLink = null;

            for (let link de linksEncontrados) {
                // Limpiar el link de caracteres extra de HTML
                let limpio = link.split('"')[0].split("'")[0].replace(/&amp;/g, '&');
                if (limpio.includes("update-home") || limpio.includes("confirm-account") || limpio.includes("nm_hp")) {
                    elLink = limpio;
                    break; 
                }
            }

            // Reporte Admin
            await enviarWA(ADMIN_PHONE, `📩 *ANALIZANDO*\n📧 Cuenta: ${correoCuenta}\n👤 Perfil: "${perfilDelCorreo}"\n🔗 Link: ${elLink ? "✅ ENCONTRADO" : "❌ NO ENCONTRADO"}`);

            if (elLink && perfilDelCorreo !== "DESCONOCIDO") {
                const cliente = clientes.find(c => 
                    (c[4] || "").toLowerCase().trim() === correoCuenta && 
                    (c[6] || "").toLowerCase().trim() === perfilDelCorreo.toLowerCase()
                );

                if (cliente) {
                    await enviarWA(cliente[2], `🏠 *ACTIVA TU TV*\n\nHola *${cliente[1]}*, dale clic aquí:\n${elLink}`);
                    await enviarWA(ADMIN_PHONE, `✅ *ENVIADO A*: ${cliente[1]}`);
                } else {
                    await enviarWA(ADMIN_PHONE, `⚠️ *SIN REGISTRO*: Perfil "${perfilDelCorreo}" no coincide en el Excel.`);
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
