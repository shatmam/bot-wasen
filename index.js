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

        // Buscamos los últimos correos de Netflix (leídos o no para esta prueba)
        let list = await client.search({ from: "netflix" });
        let ultimos = list.slice(-5).reverse(); 

        for (let seq of ultimos) {
            let msg = await client.fetchOne(seq, { source: true, envelope: true });
            let parsed = await simpleParser(msg.source);
            let html = parsed.html || "";
            let text = (parsed.text || "").replace(/\s+/g, ' '); // Limpiar espacios extra
            let correoCuenta = (msg.envelope.to[0].address || "").toLowerCase().trim();

            // 1. MEJORADO: Detección de Perfil (Busca "Solicitud de X" o "para X")
            let perfilDelCorreo = "No detectado";
            const regexPerfil = /(?:Solicitud de|para)\s+([a-zA-Z0-9áéíóúÁÉÍÓÚñÑ]+)/i;
            const matchPerfil = text.match(regexPerfil);
            if (matchPerfil) perfilDelCorreo = matchPerfil[1].trim().toLowerCase();

            // 2. MEJORADO: Captura de Link (Busca cualquier URL de Netflix que contenga confirm o update)
            const regexLink = /https:\/\/www\.netflix\.com\/[^\s"<>]+(?:confirm-account|update-home)[^\s"<>]+/gi;
            const linksEncontrados = html.match(regexLink) || text.match(regexLink);

            if (linksEncontrados) {
                const elLink = linksEncontrados[0];
                
                // Buscar cliente en Excel (Col E y Col G)
                const clienteCorrecto = clientes.find(c => {
                    const correoExcel = (c[4] || "").toLowerCase().trim();
                    const perfilExcel = (c[6] || "").toLowerCase().trim();
                    return correoExcel === correoCuenta && 
                           (perfilDelCorreo.includes(perfilExcel) || perfilExcel.includes(perfilDelCorreo));
                });

                if (clienteCorrecto) {
                    await enviarWA(clienteCorrecto[2], `🏠 *ACTUALIZACIÓN NETFLIX*\n\nHola *${clienteCorrecto[1]}*, detectamos tu solicitud en el perfil *${perfilDelCorreo.toUpperCase()}*.\n\nPulsa aquí para activar:\n${elLink}`);
                    await enviarWA(ADMIN_PHONE, `✅ *ENVIADO*: ${clienteCorrecto[1]} (Perfil ${perfilDelCorreo})`);
                } else {
                    await enviarWA(ADMIN_PHONE, `⚠️ *SIN COINCIDENCIA*:\n📧 Cuenta: ${correoCuenta}\n👤 Perfil correo: "${perfilDelCorreo}"\n\nVerifica que el perfil "${perfilDelCorreo}" esté en la Columna G.`);
                }
            } else {
                await enviarWA(ADMIN_PHONE, `❌ *LINK NO ENCONTRADO*: Cuenta ${correoCuenta}. Por favor, reenvía este correo a soporte.`);
            }
        }
        await client.logout();
    } catch (e) {
        if (client) await client.logout().catch(() => {});
    }
}

procesarCorreos();
setInterval(procesarCorreos, 20000);
