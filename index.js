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

        const res = await fetch("https://www.wasenderapi.com/api/send-message", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${WA_TOKEN}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ to: "+" + numero, text: msj })
        });

        const data = await res.json();
        console.log("📩 WA:", data);

    } catch (e) {
        console.log("❌ Error WA:", e.message);
    }
}

async function procesarCorreos() {
    const client = new ImapFlow({
        host: "imap.gmail.com",
        port: 993,
        secure: true,
        auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS
        },
        tls: { rejectUnauthorized: false }
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

        // 🔥 Búsqueda mejorada
        let list = await client.search({
            or: [
                { from: "netflix" },
                { from: "info@netflix.com" },
                { from: "no-reply@netflix.com" }
            ]
        });

        for (let seq of list.slice(-30).reverse()) {

            let meta = await client.fetchOne(seq, { envelope: true });
            let uid = meta.envelope.messageId;

            if (correosProcesados.has(uid)) continue;

            let msg = await client.fetchOne(seq, { source: true });
            let parsed = await simpleParser(msg.source);

            // ✅ HTML correcto
            let htmlRaw = parsed.textAsHtml || parsed.html || "";

            // 🔥 LIMPIEZA CORRECTA (sin romper links)
            let htmlLimpio = htmlRaw
                .replace(/=\r?\n/g, "")   // une líneas cortadas
                .replace(/&amp;/g, "&");  // corrige entidades

            // 🔥 EXTRAER LINK BIEN (CLAVE)
            const linkMatch = htmlLimpio.match(/https:\/\/www\.netflix\.com\/[^\s"<>]+/i);
            const elLink = linkMatch ? linkMatch[0].trim() : null;

            // TEXTO
            let text = (parsed.text || "").replace(/\s+/g, ' ');

            let correoCuenta = (
                meta.envelope.to && meta.envelope.to[0]?.address || ""
            ).toLowerCase().trim();

            const matchSolicitud = text.match(/Solicitud de\s+([a-zA-Z0-9áéíóúÁÉÍÓÚñÑ ]+)/i);
            const matchHola = text.match(/Hola,\s*([^:]+):/i);

            let perfilDelCorreo = matchSolicitud
                ? matchSolicitud[1].trim()
                : (matchHola ? matchHola[1].trim() : "DESCONOCIDO");

            if (elLink && perfilDelCorreo !== "DESCONOCIDO") {

                const perfilBusqueda = perfilDelCorreo.toLowerCase().trim();
                const llaveSpam = `${correoCuenta}-${perfilBusqueda}`;
                const ahora = Date.now();

                if (enviosRecientes.has(llaveSpam) &&
                    (ahora - enviosRecientes.get(llaveSpam) < 300000)) {
                    correosProcesados.add(uid);
                    continue;
                }

                const coincidencias = clientes.filter(c =>
                    (c[4] || "").toLowerCase().trim() === correoCuenta &&
                    (c[6] || "").toLowerCase().trim() === perfilBusqueda
                );

                if (coincidencias.length > 0) {

                    for (let cliente of coincidencias) {

                        const msjCliente =
`🏠 *ACTUALIZACIÓN NETFLIX*

Hola *${cliente[1]}*, pulsa el link para activar tu TV:

${elLink}`;

                        await enviarWA(cliente[2], msjCliente);

                        // 🔥 anti bloqueo
                        await new Promise(r => setTimeout(r, 1500));
                    }

                    console.log(`✅ Enviado link a ${perfilDelCorreo}`);
                    enviosRecientes.set(llaveSpam, ahora);
                }

                correosProcesados.add(uid);
            }
        }

        // 🔥 limpiar memoria
        if (correosProcesados.size > 500) {
            correosProcesados.clear();
        }

        await client.logout();

    } catch (e) {
        console.log("❌ ERROR GENERAL:", e);
        if (client) await client.logout().catch(() => {});
    }
}

procesarCorreos();
setInterval(procesarCorreos, RECHECK_TIME);
