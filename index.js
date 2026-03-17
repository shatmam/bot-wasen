require('dotenv').config();
const { ImapFlow } = require("imapflow");
const { simpleParser } = require('mailparser');
const { google } = require("googleapis");
const fetch = require("node-fetch");

const WA_TOKEN = process.env.WA_TOKEN;
const RECHECK_TIME = 1 * 60 * 1000;

const correosProcesados = new Set();
const enviosRecientes = new Map();

// 🔥 evita que el bot muera
process.on('uncaughtException', err => {
    console.log("💥 ERROR GLOBAL:", err.message);
});

process.on('unhandledRejection', err => {
    console.log("💥 PROMISE ERROR:", err);
});

// ✅ WhatsApp
async function enviarWA(tel, msj) {
    try {
        let numero = (tel || "").toString().replace(/[^0-9]/g, "");
        if (!numero) return;

        if (!numero.startsWith("1") && numero.length === 10) {
            numero = "1" + numero;
        }

        const res = await fetch("https://www.wasenderapi.com/api/send-message", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${WA_TOKEN}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                to: "+" + numero,
                text: msj
            })
        });

        const data = await res.text();
        console.log("WA:", data);

    } catch (e) {
        console.log("❌ Error WA:", e.message);
    }
}

async function procesarCorreos() {
    let client;

    try {
        client = new ImapFlow({
            host: "imap.gmail.com",
            port: 993,
            secure: true,
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS
            },
            logger: false,
            tls: { rejectUnauthorized: false }
        });

        await client.connect();
        await client.mailboxOpen('INBOX');

        // 🔥 GOOGLE
        let clientes = [];

        try {
            const auth = new google.auth.GoogleAuth({
                credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
                scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"]
            });

            const sheets = google.sheets({ version: "v4", auth });

            const spreadsheet = await sheets.spreadsheets.values.get({
                spreadsheetId: process.env.SPREADSHEET_ID,
                range: "Clientes!A2:K1000"
            });

            clientes = spreadsheet.data.values || [];

        } catch (e) {
            console.log("❌ Error Google Sheets:", e.message);
        }

        let list = await client.search({ from: "netflix" });

        for (let seq of list.slice(-10).reverse()) {

            try {
                let meta = await client.fetchOne(seq, { envelope: true });
                let uid = meta?.envelope?.messageId;

                if (!uid) continue;
                if (correosProcesados.has(uid)) continue;

                let msg = await client.fetchOne(seq, { source: true });
                let parsed = await simpleParser(msg.source);

                let text = (parsed.text || "").replace(/\s+/g, ' ');
                let correoCuenta = (meta.envelope.to?.[0]?.address || "").toLowerCase().trim();

                // 🔥 detectar perfil
                const matchSolicitud = text.match(/Solicitud de\s+([a-zA-Z0-9áéíóúÁÉÍÓÚñÑ ]+)/i);
                const matchHola = text.match(/Hola,\s*([^:]+):/i);

                let perfilDelCorreo = matchSolicitud
                    ? matchSolicitud[1].trim()
                    : (matchHola ? matchHola[1].trim() : "DESCONOCIDO");

                if (perfilDelCorreo === "DESCONOCIDO") {
                    correosProcesados.add(uid);
                    continue;
                }

                const perfilBusqueda = perfilDelCorreo.toLowerCase().trim();
                const llaveSpam = `${correoCuenta}-${perfilBusqueda}`;
                const ahora = Date.now();

                if (enviosRecientes.has(llaveSpam) && (ahora - enviosRecientes.get(llaveSpam) < 300000)) {
                    correosProcesados.add(uid);
                    continue;
                }

                const coincidencias = clientes.filter(c =>
                    (c[4] || "").toLowerCase().trim() === correoCuenta &&
                    (c[6] || "").toLowerCase().trim() === perfilBusqueda
                );

                if (coincidencias.length > 0) {

                    for (let cliente of coincidencias) {

                        try {
                            const link = `https://codigos-production.up.railway.app/?perfil=${encodeURIComponent(perfilDelCorreo)}&cliente=${encodeURIComponent(cliente[1] || "Cliente")}`;

                            const msjCliente = `🏠 *NETFLIX*

Hola *${cliente[1] || "Cliente"}*,

Tienes una solicitud de activación.

👉 ${link}`;

                            await enviarWA(cliente[2], msjCliente);

                        } catch (e) {
                            console.log("❌ Error cliente:", e.message);
                        }
                    }

                    console.log(`✅ Enviado a ${perfilDelCorreo}`);
                    enviosRecientes.set(llaveSpam, ahora);
                }

                correosProcesados.add(uid);

            } catch (e) {
                console.log("❌ Error procesando correo:", e.message);
            }
        }

        await client.logout();

    } catch (e) {
        console.log("❌ ERROR GENERAL:", e.message);
        if (client) await client.logout().catch(() => {});
    }
}

// loop seguro
setInterval(() => {
    procesarCorreos();
}, RECHECK_TIME);

// primera ejecución
procesarCorreos();
