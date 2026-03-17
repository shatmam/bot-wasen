require('dotenv').config();
const { ImapFlow } = require("imapflow");
const { simpleParser } = require('mailparser');
const { google } = require("googleapis");
const fetch = require("node-fetch");

const ADMIN_PHONE = process.env.ADMIN_PHONE; 
const WA_TOKEN = process.env.WA_TOKEN;
const RECHECK_TIME = 1 * 60 * 1000; 

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
        const todosLosClientes = spreadsheet.data.values || [];

        let haceDosDias = new Date();
        haceDosDias.setDate(haceDosDias.getDate() - 2);
        let list = await client.search({ from: "netflix", since: haceDosDias });

        if (!botIniciado) {
            await enviarWA(ADMIN_PHONE, `🚀 *BOT TOTALMENTE VINCULADO*\nEscaneo de Correo + Perfil activo.\nMemoria anti-repetición: ON.`);
            botIniciado = true;
        }

        for (let seq of list.reverse()) {
            let meta = await client.fetchOne(seq, { envelope: true });
            let uid = meta.envelope.messageId;

            if (idsEnviados.has(uid)) continue;

            let msg = await client.fetchOne(seq, { source: true });
            let parsed = await simpleParser(msg.source);
            let htmlOriginal = parsed.html || "";
            let text = (parsed.text || "").replace(/\s+/g, ' '); 
            let correoCuenta = (meta.envelope.to[0].address || "").toLowerCase().trim();

            const linkMatch = htmlOriginal.match(/href="([^"]*update-home[^"]*)"/) || 
                              htmlOriginal.match(/href="([^"]*pin-code[^"]*)"/) || 
                              htmlOriginal.match(/href="([^"]*confirm-account[^"]*)"/);
            
            const elLink = linkMatch ? linkMatch[1].replace(/&amp;/g, "&") : null;

            const matchSolicitud = text.match(/Solicitud de\s+([a-zA-Z0-9áéíóúÁÉÍÓÚñÑ]+)/i);
            const matchHola = text.match(/Hola,\s*([^:]+):/i);
            let perfilFinal = matchSolicitud ? matchSolicitud[1].trim() : (matchHola ? matchHola[1].trim() : null);

            if (elLink && perfilFinal) {
                const perfilBusqueda = perfilFinal.toLowerCase().trim();

                const clientesCoincidentes = todosLosClientes.filter(c => 
                    (c[4] || "").toLowerCase().trim() === correoCuenta && 
                    (c[6] || "").toLowerCase().trim() === perfilBusqueda
                );

                if (clientesCoincidentes.length > 0) {
                    for (let cliente of clientesCoincidentes) {
                        const tipo = elLink.includes("pin-code") ? "ACCESO TEMPORAL" : "HOGAR";
                        await enviarWA(cliente[2], `📺 *NETFLIX ${tipo}*\n\nHola *${cliente[1]}*, activa tu perfil *${perfilFinal}* aquí:\n${elLink}`);
                    }
                    await enviarWA(ADMIN_PHONE, `✅ *ENVIADO*: ${perfilFinal} (${correoCuenta})`);
                } else {
                    await enviarWA(ADMIN_PHONE, `⚠️ *ALERTA*: Perfil "${perfilFinal}" no coincide en ${correoCuenta}. Revisa el Excel.`);
                }
                idsEnviados.add(uid);
            }
        }
        await client.logout();
    } catch (e) {
        if (client) await client.logout().catch(() => {});
    }
}

procesarCorreos();
setInterval(procesarCorreos, RECHECK_TIME);
