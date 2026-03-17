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
        
        for (let seq of list.slice(-10).reverse()) {
            let meta = await client.fetchOne(seq, { envelope: true });
            let uid = meta.envelope.messageId;

            if (correosProcesados.has(uid)) continue;

            let msg = await client.fetchOne(seq, { source: true });
            let parsed = await simpleParser(msg.source);
            
            let htmlRaw = parsed.html || "";

            // 🔥 intento de extraer link (secundario)
            let htmlLimpio = htmlRaw
                .replace(/=\r?\n/g, "")
                .replace(/&amp;/g, "&");

            const hrefs = [...htmlLimpio.matchAll(/href="([^"]+)"/gi)].map(m => m[1]);

            const linkBueno = hrefs.find(l => 
                l.includes("update-primary-location") || 
                l.includes("update-home")
            );

            let elLink = linkBueno
                ? linkBueno.replace(/\s/g, "").trim()
                : null;

            // 🔥 CONTENIDO PRINCIPAL (LO IMPORTANTE)
            let contenidoCorreo = (parsed.text || "")
                .replace(/\s+\n/g, "\n")
                .trim();

            let text = contenidoCorreo.replace(/\s+/g, ' '); 
            let correoCuenta = (meta.envelope.to[0].address || "").toLowerCase().trim();

            const matchSolicitud = text.match(/Solicitud de\s+([a-zA-Z0-9áéíóúÁÉÍÓÚñÑ ]+)/i);
            const matchHola = text.match(/Hola,\s*([^:]+):/i);
            let perfilDelCorreo = matchSolicitud ? matchSolicitud[1].trim() : (matchHola ? matchHola[1].trim() : "DESCONOCIDO");

            if ((contenidoCorreo || elLink) && perfilDelCorreo !== "DESCONOCIDO") {

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

                        const msjCliente = `🏠 *ACTUALIZACIÓN NETFLIX*

Hola *${cliente[1]}*,

Sigue las instrucciones del mensaje:

${contenidoCorreo}

${elLink ? "\n🔗 Link directo:\n" + elLink : ""}`;

                        await enviarWA(cliente[2], msjCliente);
                    }

                    console.log(`✅ Enviado correo completo a ${perfilDelCorreo}`);
                    enviosRecientes.set(llaveSpam, ahora); 
                }

                correosProcesados.add(uid);
            }
        }

        await client.logout();

    } catch (e) {
        console.log("❌ ERROR:", e.message);
        if (client) await client.logout().catch(() => {});
    }
}

procesarCorreos();
setInterval(procesarCorreos, RECHECK_TIME);
