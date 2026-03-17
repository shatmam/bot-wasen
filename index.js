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
const RECHECK_TIME = 1 * 60 * 1000; // Revisar cada 1 minuto

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
    console.log("🔍 Revisando Gmail y Google Sheets...");
    const client = new ImapFlow({
        host: "imap.gmail.com", port: 993, secure: true,
        auth: { user: EMAIL_USER, pass: EMAIL_PASS },
        logger: false, tls: { rejectUnauthorized: false }
    });

    try {
        // 1. Conexión a Gmail
        await client.connect();
        await client.mailboxOpen('INBOX');

        // 2. Conexión a Google Sheets
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

        // Notificación de primer arranque para el Admin
        if (!botIniciado) {
            await enviarWA(ADMIN_PHONE, `🚀 *BOT INICIADO CORRECTAMENTE*\n\n📊 *Sincronización*: SÍ\n👥 *Clientes leídos*: ${clientes.length}\n📧 *Correo*: ${EMAIL_USER}\n\nEl sistema está vigilando correos nuevos cada minuto.`);
            botIniciado = true;
            console.log(`✅ Bot activo. Sincronizados ${clientes.length} clientes.`);
        }

        // 3. Buscar correos NO LEÍDOS de Netflix
        let list = await client.search({ from: "netflix", unseen: true });

        for (let seq of list) {
            let msg = await client.fetchOne(seq, { source: true, envelope: true });
            let parsed = await simpleParser(msg.source);
            let subject = (msg.envelope.subject || "").toLowerCase();
            let html = parsed.html || parsed.textAsHtml || "";
            let contenido = (parsed.text || "").toLowerCase();

            // Filtros de utilidad
            const esUtil = subject.includes("código") || subject.includes("codigo") || subject.includes("temporal") || subject.includes("hogar");
            const esCambio = subject.includes("contraseña") || subject.includes("password") || contenido.includes("restablecer");

            if (esUtil && !esCambio) {
                const correoDestino = (msg.envelope.to[0].address || "").toLowerCase().trim();
                const linkMatch = html.match(/href="([^"]*update-home[^"]*)"/) || 
                                 html.match(/href="([^"]*confirm-account[^"]*)"/);
                
                if (linkMatch) {
                    const elLink = linkMatch[1];
                    const cliente = clientes.find(c => (c[4] || "").toLowerCase().trim() === correoDestino);

                    if (cliente) {
                        // Enviar al cliente
                        await enviarWA(cliente[2], `🏠 *ACTUALIZACIÓN NETFLIX*\n\nHola *${cliente[1]}*, activa tu TV aquí:\n\n${elLink}`);
                        // Reportar éxito al Admin
                        await enviarWA(ADMIN_PHONE, `✅ *LINK ENVIADO*\n👤: ${cliente[1]}\n📧: ${correoDestino}\n📱: ${cliente[2]}`);
                    } else {
                        // Reportar correo sin registro en Excel
                        await enviarWA(ADMIN_PHONE, `⚠️ *CUENTA DESCONOCIDA*\nLlegó un link para: ${correoDestino}\nPero no está en el Excel.\n\n🔗 Link: ${elLink}`);
                    }
                }
            }
            // Marcar como leído
            await client.messageFlagsAdd(seq, ['\\Seen']);
        }
        await client.logout();
    } catch (e) {
        console.log("❌ Error fatal:", e.message);
        await enviarWA(ADMIN_PHONE, `🚨 *ERROR CRÍTICO*: ${e.message}`);
        if (client) await client.logout().catch(() => {});
    }
}

// Ejecución cíclica
procesarCorreos();
setInterval(procesarCorreos, RECHECK_TIME);
