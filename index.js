require('dotenv').config();
const { ImapFlow } = require("imapflow");
const { simpleParser } = require('mailparser');
const { google } = require("googleapis");
const fetch = require("node-fetch");

const EMAIL_USER = process.env.EMAIL_USER; 
const EMAIL_PASS = process.env.EMAIL_PASS; 
const SPREADSHEET_ID = process.env.SPREADSHEET_ID; 
const WA_TOKEN = process.env.WA_TOKEN; 
const ADMIN_PHONE = process.env.ADMIN_PHONE; 
const RECHECK_TIME = 15 * 1000; 

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
    console.log("⚡ Escaneando últimos correos...");
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

        // Mantenemos el conteo que te funcionó
        if (!botIniciado) {
            await enviarWA(ADMIN_PHONE, `🚀 *BOT MODO PRUEBA ACTIVO*\n\n📊 *Clientes leídos*: ${clientes.length}\n⏱️ *Frecuencia*: 15 seg.\n📂 *Rango*: Últimos 2 correos (Leídos o no).`);
            botIniciado = true;
        }

        // Buscamos los correos de Netflix (quitamos el filtro de 'unseen')
        let list = await client.search({ from: "netflix" });
        
        // Solo tomamos los últimos 2 para la prueba
        for (let seq of list.slice(-2).reverse()) {
            let msg = await client.fetchOne(seq, { source: true, envelope: true });
            let parsed = await simpleParser(msg.source);
            
            let contenido = (parsed.text || "").toLowerCase();
            let html = parsed.html || parsed.textAsHtml || "";
            let correoCuenta = (msg.envelope.to[0].address || "").toLowerCase().trim();

            const perfilMatch = contenido.match(/solicitud de\s+([^\n,]+)/i);
            let perfilDelCorreo = perfilMatch ? perfilMatch[1].trim().toLowerCase() : null;

            if (perfilDelCorreo) {
                const clienteCorrecto = clientes.find(c => 
                    (c[4] || "").toLowerCase().trim() === correoCuenta && 
                    (c[6] || "").toLowerCase().trim() === perfilDelCorreo
                );

                if (clienteCorrecto) {
                    const linkMatch = html.match(/href="([^"]*update-home[^"]*)"/) || 
                                     html.match(/href="([^"]*confirm-account[^"]*)"/);

                    if (linkMatch) {
                        const elLink = linkMatch[1];
                        const msj = `🏠 *PRUEBA DE ACTIVACIÓN*\n\nHola *${clienteCorrecto[1]}*, detectamos tu solicitud para el perfil: *${perfilDelCorreo.toUpperCase()}*.\n\nPulsa aquí:\n${elLink}`;
                        
                        await enviarWA(clienteCorrecto[2], msj);
                        await enviarWA(ADMIN_PHONE, `✅ *PRUEBA EXITOSA*: Enviado a ${clienteCorrecto[1]} (Perfil: ${perfilDelCorreo})`);
                    }
                } else {
                    console.log(`Perfil ${perfilDelCorreo} no coincide para la cuenta ${correoCuenta}`);
                }
            }
        }
        await client.logout();
    } catch (e) {
        console.log("❌ Error:", e.message);
        if (client) await client.logout().catch(() => {});
    }
}

procesarCorreos();
setInterval(procesarCorreos, RECHECK_TIME);
