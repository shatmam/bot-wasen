require('dotenv').config();
const { ImapFlow } = require("imapflow");
const { simpleParser } = require('mailparser');
const { google } = require("googleapis");
const fetch = require("node-fetch");

// ================= CONFIGURACIÓN =================
const EMAIL_USER = process.env.EMAIL_USER; 
const EMAIL_PASS = process.env.EMAIL_PASS; 
const SPREADSHEET_ID = process.env.SPREADSHEET_ID; 
const WA_TOKEN = process.env.WA_TOKEN; 
const ADMIN_PHONE = process.env.ADMIN_PHONE; 
const RECHECK_TIME = 15 * 1000; // 🚀 AHORA REVISA CADA 15 SEGUNDOS

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
    console.log("⚡ Revisión rápida iniciada...");
    const client = new ImapFlow({
        host: "imap.gmail.com", port: 993, secure: true,
        auth: { user: EMAIL_USER, pass: EMAIL_PASS },
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
            spreadsheetId: SPREADSHEET_ID, 
            range: "Clientes!A2:K1000" 
        });
        const clientes = spreadsheet.data.values || [];

        if (!botIniciado) {
            await enviarWA(ADMIN_PHONE, `🚀 *BOT ULTRA-RÁPIDO ACTIVO*\n\nRevisando cada 15 segundos.\nSincronizados ${clientes.length} clientes.\nValidando por Correo y Perfil (Columna G).`);
            botIniciado = true;
        }

        // Buscar correos NO LEÍDOS de Netflix
        let list = await client.search({ from: "netflix", unseen: true });

        for (let seq of list) {
            let msg = await client.fetchOne(seq, { source: true, envelope: true });
            let parsed = await simpleParser(msg.source);
            let contenido = (parsed.text || "").toLowerCase();
            let html = parsed.html || parsed.textAsHtml || "";

            // 1. Extraer Perfil del cuerpo del correo
            const perfilMatch = contenido.match(/solicitud de\s+([^\n,]+)/i);
            const perfilDelCorreo = perfilMatch ? perfilMatch[1].trim().toLowerCase() : null;

            if (perfilDelCorreo) {
                const correoCuenta = (msg.envelope.to[0].address || "").toLowerCase().trim();
                
                // 2. Buscar cliente por CORREO (Columna E/c[4]) y PERFIL (Columna G/c[6])
                const clienteCorrecto = clientes.find(c => 
                    (c[4] || "").toLowerCase().trim() === correoCuenta && 
                    (c[6] || "").toLowerCase().trim() === perfilDelCorreo
                );

                if (clienteCorrecto) {
                    const linkMatch = html.match(/href="([^"]*update-home[^"]*)"/) || 
                                     html.match(/href="([^"]*confirm-account[^"]*)"/);

                    if (linkMatch) {
                        const elLink = linkMatch[1];
                        const msj = `🏠 *ACTUALIZACIÓN NETFLIX*\n\nHola *${clienteCorrecto[1]}*, detectamos tu solicitud en el perfil *${perfilDelCorreo.toUpperCase()}*.\n\nPulsa el botón para activar tu TV:\n\n${elLink}\n\n_Vence en 15 minutos._`;
                        
                        await enviarWA(clienteCorrecto[2], msj);
                        await enviarWA(ADMIN_PHONE, `✅ *ENVIADO*: ${clienteCorrecto[1]} (Perfil ${perfilDelCorreo}) de la cuenta ${correoCuenta}`);
                    }
                } else {
                    // Si el perfil no coincide con nadie en el Excel
                    await enviarWA(ADMIN_PHONE, `⚠️ *PERFIL NO ASIGNADO*\nAlguien pidió acceso en el perfil "${perfilDelCorreo}" para ${correoCuenta}, pero nadie tiene ese perfil en el Excel.`);
                }
            }
            // Marcar como leído para no repetir en 15 segundos
            await client.messageFlagsAdd(seq, ['\\Seen']);
        }
        await client.logout();
    } catch (e) {
        console.log("❌ Error:", e.message);
        if (client) await client.logout().catch(() => {});
    }
}

procesarCorreos();
setInterval(procesarCorreos, RECHECK_TIME);
