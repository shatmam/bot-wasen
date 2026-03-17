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

// Función actualizada para enviar BOTONES
async function enviarWA(tel, msj, btnLink = null) {
    try {
        let numero = tel.toString().replace(/[^0-9]/g, "");
        if (!numero.startsWith("1") && numero.length === 10) numero = "1" + numero;

        const body = {
            to: "+" + numero,
            text: msj
        };

        // Si hay un link, creamos el botón
        if (btnLink) {
            body.buttons = [
                {
                    type: "url",
                    display: "✅ ACTIVAR AHORA",
                    url: btnLink
                }
            ];
        }

        await fetch("https://www.wasenderapi.com/api/send-message", {
            method: "POST",
            headers: { "Authorization": `Bearer ${WA_TOKEN}`, "Content-Type": "application/json" },
            body: JSON.stringify(body)
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

        // Buscamos correos de Netflix
        let list = await client.search({ from: "netflix" });
        
        for (let seq of list.slice(-15).reverse()) {
            let meta = await client.fetchOne(seq, { envelope: true });
            let uid = meta.envelope.messageId;

            if (correosProcesados.has(uid)) continue;

            let msg = await client.fetchOne(seq, { source: true });
            let parsed = await simpleParser(msg.source);
            let htmlOriginal = parsed.html || parsed.textAsHtml || "";
            let text = (parsed.text || "").replace(/\s+/g, ' '); 
            let correoCuenta = (meta.envelope.to[0].address || "").toLowerCase().trim();

            // 1. RECONOCIMIENTO DE LINK (Hogar, Temporal y el link largo que pasaste)
            const linkMatch = htmlOriginal.match(/href="([^"]*update-primary-location[^"]*)"/) || 
                              htmlOriginal.match(/href="([^"]*update-home[^"]*)"/) || 
                              htmlOriginal.match(/href="([^"]*pin-code[^"]*)"/) || 
                              htmlOriginal.match(/href="([^"]*confirm-account[^"]*)"/);
            
            const elLink = linkMatch ? linkMatch[1].replace(/&amp;/g, "&") : null;

            // 2. EXTRACCIÓN DE PERFIL
            const matchSolicitud = text.match(/Solicitud de\s+([a-zA-Z0-9áéíóúÁÉÍÓÚñÑ ]+?)(?=\s+para|\.|$)/i);
            const matchHola = text.match(/Hola,\s*([^:]+):/i);
            let perfilDelCorreo = matchSolicitud ? matchSolicitud[1].trim() : (matchHola ? matchHola[1].trim() : "DESCONOCIDO");

            if (elLink && perfilDelCorreo !== "DESCONOCIDO") {
                const perfilBusqueda = perfilDelCorreo.toLowerCase().trim();
                const llaveSpam = `${correoCuenta}-${perfilBusqueda}`;
                const ahora = Date.now();

                // Evitar spam: solo 1 mensaje por perfil cada 3 minutos
                if (enviosRecientes.has(llaveSpam) && (ahora - enviosRecientes.get(llaveSpam) < 180000)) {
                    correosProcesados.add(uid);
                    continue;
                }

                // Filtramos la hoja completa buscando Correo + Perfil
                const clientesEncontrados = clientes.filter(c => 
                    (c[4] || "").toLowerCase().trim() === correoCuenta && 
                    (c[6] || "").toLowerCase().trim() === perfilBusqueda
                );

                if (clientesEncontrados.length > 0) {
                    for (let cliente of clientesEncontrados) {
                        const esTemporal = elLink.includes("pin-code");
                        const txt = `📺 *NETFLIX: ${esTemporal ? 'ACCESO TEMPORAL' : 'ACTUALIZAR HOGAR'}*\n\nHola *${cliente[1]}*, detectamos tu solicitud para el perfil *${perfilDelCorreo}*.\n\nUsa el botón de abajo para activar:`;
                        
                        // Enviamos con botón
                        await enviarWA(cliente[2], txt, elLink);
                    }
                    await enviarWA(ADMIN_PHONE, `✅ *BOTÓN ENVIADO*: ${perfilDelCorreo} (${correoCuenta})`);
                    enviosRecientes.set(llaveSpam, ahora);
                } else {
                    await enviarWA(ADMIN_PHONE, `⚠️ *SIN COINCIDENCIA*: "${perfilDelCorreo}" en ${correoCuenta}.`);
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
