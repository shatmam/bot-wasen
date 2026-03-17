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

        // 🟢 FILTRO CRÍTICO: Solo correos de Netflix que NO hayan sido leídos
        let list = await client.search({ from: "netflix", unseen: true });

        for (let seq of list) {
            let msg = await client.fetchOne(seq, { source: true, envelope: true });
            let parsed = await simpleParser(msg.source);
            let html = parsed.html || "";
            let text = (parsed.text || "").replace(/\s+/g, ' '); 
            let correoCuenta = (msg.envelope.to[0].address || "").toLowerCase().trim();

            // Detección de Perfil
            let perfilDelCorreo = "No detectado";
            const matchPerfil = text.match(/Solicitud de\s+([a-zA-Z0-9]+)/i);
            if (matchPerfil) perfilDelCorreo = matchPerfil[1].trim().toLowerCase();

            // Detección de Link
            const regexLink = /https:\/\/www\.netflix\.com\/[^\s"<>]+(?:confirm-account|update-home)[^\s"<>]+/gi;
            const links = html.match(regexLink) || text.match(regexLink);

            if (links) {
                const elLink = links[0];
                const cliente = clientes.find(c => 
                    (c[4] || "").toLowerCase().trim() === correoCuenta && 
                    (c[6] || "").toLowerCase().trim() === perfilDelCorreo
                );

                if (cliente) {
                    await enviarWA(cliente[2], `🏠 *NETFLIX ACTUALIZADO*\n\nHola *${cliente[1]}*, activa tu TV aquí:\n${elLink}`);
                    await enviarWA(ADMIN_PHONE, `✅ *ENVIADO*: ${cliente[1]} (${perfilDelCorreo})`);
                } else {
                    await enviarWA(ADMIN_PHONE, `⚠️ *SIN REGISTRO*: Perfil "${perfilDelCorreo}" en ${correoCuenta}. Revisa tu Excel.`);
                }
            }

            // 🔴 MARCAR COMO LEÍDO: Esto evita que se repita el mensaje (Adiós Spam)
            await client.messageFlagsAdd(seq, ['\\Seen']);
        }
        await client.logout();
    } catch (e) {
        if (client) await client.logout().catch(() => {});
    }
}

// Ejecutar cada 20 segundos
procesarCorreos();
setInterval(procesarCorreos, 20000);
