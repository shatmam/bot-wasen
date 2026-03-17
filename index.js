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
        const clientesExcel = spreadsheet.data.values || [];

        let list = await client.search({ from: "netflix" });
        
        for (let seq of list.slice(-20).reverse()) {
            let meta = await client.fetchOne(seq, { envelope: true });
            let uid = meta.envelope.messageId;

            if (correosProcesados.has(uid)) continue;

            let msg = await client.fetchOne(seq, { source: true });
            let parsed = await simpleParser(msg.source);
            let htmlOriginal = parsed.html || parsed.textAsHtml || "";
            let text = (parsed.text || "").replace(/\s+/g, ' '); 
            let correoCuenta = (meta.envelope.to[0].address || "").toLowerCase().trim();

            // 1. EXTRAER LINK (Detecta el link de hogar largo que me pasaste)
            const linkMatch = htmlOriginal.match(/href="([^"]*update-primary-location[^"]*)"/) || 
                              htmlOriginal.match(/href="([^"]*update-home[^"]*)"/) || 
                              htmlOriginal.match(/href="([^"]*confirm-account[^"]*)"/) ||
                              htmlOriginal.match(/href="([^"]*netflix.com\/browse[^"]*)"/);
            
            const elLink = linkMatch ? linkMatch[1].replace(/&amp;/g, "&") : null;

            // 2. EXTRAER CONTEXTO (La parte del correo que explica la solicitud)
            const matchSolicitud = text.match(/Solicitud de\s+([a-zA-Z0-9áéíóúÁÉÍÓÚñÑ ]+)/i);
            const matchHola = text.match(/Hola,\s*([^:]+):/i);
            let perfilCorreo = matchSolicitud ? matchSolicitud[1].trim() : (matchHola ? matchHola[1].trim() : "DESCONOCIDO");

            if (elLink && perfilCorreo !== "DESCONOCIDO") {
                const perfilBusqueda = perfilCorreo.toLowerCase().trim();
                const llaveAntiSpam = `${correoCuenta}-${perfilBusqueda}`;
                const ahora = Date.now();

                // Anti-Spam de 3 minutos por perfil
                if (enviosRecientes.has(llaveAntiSpam) && (ahora - enviosRecientes.get(llaveAntiSpam) < 180000)) {
                    correosProcesados.add(uid);
                    continue;
                }

                const coincidencias = clientesExcel.filter(c => 
                    (c[4] || "").toLowerCase().trim() === correoCuenta && 
                    (c[6] || "").toLowerCase().trim() === perfilBusqueda
                );

                if (coincidencias.length > 0) {
                    for (let cliente of coincidencias) {
                        // Construimos el mensaje con el texto del correo + el link
                        const mensajeFinal = `📺 *NOTIFICACIÓN DE NETFLIX*\n\n` +
                            `Hola *${cliente[1]}*, se detectó una solicitud para el perfil: *${perfilCorreo}*.\n\n` +
                            `*Copia y abre este enlace para activar:*\n${elLink}`;
                        
                        await enviarWA(cliente[2], mensajeFinal);
                    }
                    await enviarWA(ADMIN_PHONE, `✅ *ENVIADO*: ${perfilCorreo} (${correoCuenta})`);
                    enviosRecientes.set(llaveAntiSpam, ahora);
                } else {
                    await enviarWA(ADMIN_PHONE, `⚠️ *PERFIL NO REGISTRADO*: "${perfilCorreo}" en ${correoCuenta}.`);
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
