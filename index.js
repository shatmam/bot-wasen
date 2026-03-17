require('dotenv').config();
const { ImapFlow } = require("imapflow");
const { simpleParser } = require('mailparser');
const { google } = require("googleapis");
const fetch = require("node-fetch");

const ADMIN_PHONE = process.env.ADMIN_PHONE; 
const WA_TOKEN = process.env.WA_TOKEN;
const RECHECK_TIME = 1 * 60 * 1000; 

const correosProcesados = new Set();
const enviosRecientes = new Map(); 

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

        let list = await client.search({ from: "netflix" });
        
        for (let seq of list.slice(-15).reverse()) {
            let meta = await client.fetchOne(seq, { envelope: true });
            let uid = meta.envelope.messageId;

            if (correosProcesados.has(uid)) continue;

            let msg = await client.fetchOne(seq, { source: true });
            let parsed = await simpleParser(msg.source);
            
            // Limpieza básica de HTML para no romper el link
            let htmlOriginal = (parsed.html || parsed.textAsHtml || "").replace(/[\r\n]/g, "");
            let text = (parsed.text || "").replace(/\s+/g, ' '); 
            let correoCuenta = (meta.envelope.to[0].address || "").toLowerCase().trim();

            // EXTRACCIÓN DEL LINK (Priorizando el de actualización de hogar)
            const linkMatch = htmlOriginal.match(/href="([^"]*update-primary-location[^"]*)"/i) || 
                              htmlOriginal.match(/href="([^"]*update-home[^"]*)"/i) || 
                              htmlOriginal.match(/href="([^"]*confirm-account[^"]*)"/i);
            
            const elLink = linkMatch ? linkMatch[1].replace(/&amp;/g, "&").replace(/\s/g, "") : null;

            // EXTRACCIÓN DE PERFIL
            const matchSolicitud = text.match(/Solicitud de\s+([a-zA-Z0-9áéíóúÁÉÍÓÚñÑ ]+)/i);
            let perfilDelCorreo = matchSolicitud ? matchSolicitud[1].trim() : "DESCONOCIDO";

            if (elLink && perfilDelCorreo !== "DESCONOCIDO") {
                const perfilBusqueda = perfilDelCorreo.toLowerCase().trim();
                const llaveSpam = `${correoCuenta}-${perfilBusqueda}`;
                const ahora = Date.now();

                // Anti-spam por perfil (3 minutos)
                if (enviosRecientes.has(llaveSpam) && (ahora - enviosRecientes.get(llaveSpam) < 180000)) {
                    correosProcesados.add(uid);
                    continue;
                }

                // BUSCAR EN EXCEL
                const coincidencias = clientes.filter(c => 
                    (c[4] || "").toLowerCase().trim() === correoCuenta && 
                    (c[6] || "").toLowerCase().trim() === perfilBusqueda
                );

                if (coincidencias.length > 0) {
                    for (let cliente of coincidencias) {
                        const msjCliente = `🏠 *ACTUALIZACIÓN NETFLIX*\n\nHola *${cliente[1]}*, pulsa el link para activar tu TV en el perfil *${perfilDelCorreo}*:\n\n${elLink}`;
                        await enviarWA(cliente[2], msjCliente);
                    }
                    await enviarWA(ADMIN_PHONE, `✅ *ENVIADO*: ${perfilDelCorreo} (${correoCuenta})`);
                    enviosRecientes.set(llaveSpam, ahora);
                } else {
                    await enviarWA(ADMIN_PHONE, `⚠️ *SIN REGISTRO*: ${perfilDelCorreo} en ${correoCuenta}`);
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
