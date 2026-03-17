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
const RECHECK_TIME = 20 * 1000; // 20 segundos para no saturar Gmail

let botIniciado = false;

async function enviarWA(tel, msj) {
    try {
        let numero = tel.toString().replace(/[^0-9]/g, "");
        if (!numero.startsWith("1") && numero.length === 10) numero = "1" + numero;
        const response = await fetch("https://www.wasenderapi.com/api/send-message", {
            method: "POST",
            headers: { "Authorization": `Bearer ${WA_TOKEN}`, "Content-Type": "application/json" },
            body: JSON.stringify({ to: numero, text: msj })
        });
        return await response.json();
    } catch (e) { console.log("❌ Error WA:", e.message); }
}

async function procesarCorreos() {
    console.log("🔍 Iniciando escaneo de diagnóstico...");
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
            await enviarWA(ADMIN_PHONE, `🔎 *DIAGNÓSTICO INICIADO*\n📊 Clientes en Excel: ${clientes.length}\n📅 Buscando correos desde ayer.`);
            botIniciado = true;
        }

        // Buscamos correos de Netflix desde ayer
        let fechaAyer = new Date();
        fechaAyer.setDate(fechaAyer.getDate() - 1);
        
        let list = await client.search({ from: "netflix", since: fechaAyer });
        console.log(`Se encontraron ${list.length} correos de Netflix desde ayer.`);

        for (let seq of list.reverse()) { // Del más nuevo al más viejo
            let msg = await client.fetchOne(seq, { source: true, envelope: true });
            let parsed = await simpleParser(msg.source);
            let contenido = (parsed.text || "").toLowerCase();
            let html = parsed.html || parsed.textAsHtml || "";
            let correoCuenta = (msg.envelope.to[0].address || "").toLowerCase().trim();

            // Detectar link
            const linkMatch = html.match(/href="([^"]*update-home[^"]*)"/) || 
                             html.match(/href="([^"]*confirm-account[^"]*)"/);

            if (linkMatch) {
                const elLink = linkMatch[1];
                const perfilMatch = contenido.match(/solicitud de\s+([^\n,]+)/i);
                let perfilDelCorreo = perfilMatch ? perfilMatch[1].trim().toLowerCase() : "no detectado";

                // REPORTE AL ADMIN POR CADA CORREO ENCONTRADO
                console.log(`Analizando: Cuenta ${correoCuenta} | Perfil: ${perfilDelCorreo}`);

                // Intentar match
                const clienteCorrecto = clientes.find(c => {
                    const correoExcel = (c[4] || "").toLowerCase().trim();
                    const perfilExcel = (c[6] || "").toLowerCase().trim();
                    // Match flexible: que el perfil del correo contenga lo que dice el Excel o viceversa
                    return correoExcel === correoCuenta && (perfilDelCorreo.includes(perfilExcel) || perfilExcel.includes(perfilDelCorreo));
                });

                if (clienteCorrecto) {
                    await enviarWA(clienteCorrecto[2], `🏠 *ACTUALIZACIÓN NETFLIX*\n\nPerfil: *${perfilDelCorreo.toUpperCase()}*\nLink: ${elLink}`);
                    await enviarWA(ADMIN_PHONE, `✅ *ÉXITO*: Se envió a ${clienteCorrecto[1]} para la cuenta ${correoCuenta}.`);
                } else {
                    // Si no hay match, te explica por qué
                    let errorMsg = `⚠️ *FALLO DE COINCIDENCIA*\n\n` +
                                   `📧 Cuenta correo: ${correoCuenta}\n` +
                                   `👤 Perfil correo: "${perfilDelCorreo}"\n\n` +
                                   `🔍 Revisa si en tu Excel tienes una fila con ese correo exacto y si en la Columna G dice exactamente ese perfil.`;
                    await enviarWA(ADMIN_PHONE, errorMsg);
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
