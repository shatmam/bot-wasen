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
const RECHECK_TIME = 1 * 60 * 1000; // 1 minuto

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
    console.log("🔍 Revisando Gmail...");
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

        // Buscar solo correos NO LEÍDOS de Netflix
        let list = await client.search({ from: "netflix", unseen: true });

        if (list.length > 0) {
            console.log(`📩 Se encontraron ${list.length} correos nuevos.`);
        }

        for (let seq of list) {
            let msg = await client.fetchOne(seq, { source: true, envelope: true });
            let parsed = await simpleParser(msg.source);
            let subject = (msg.envelope.subject || "").toLowerCase();
            let html = parsed.html || parsed.textAsHtml || "";
            let contenido = (parsed.text || "").toLowerCase();

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
                        // 1. Notificar al Cliente
                        await enviarWA(cliente[2], `🏠 *ACTUALIZACIÓN NETFLIX*\n\nHola *${cliente[1]}*, activa tu TV aquí:\n\n${elLink}`);
                        
                        // 2. Notificar al Admin (Éxito)
                        await enviarWA(ADMIN_PHONE, `✅ *ENVIADO AUTOMÁTICO*\n\n👤 Cliente: ${cliente[1]}\n📧 Cuenta: ${correoDestino}\n📱 Tel: ${cliente[2]}`);
                    } else {
                        // 3. Notificar al Admin (Error: Cliente no está en Excel)
                        await enviarWA(ADMIN_PHONE, `⚠️ *CORREO SIN DUEÑO*\n\nLlegó un link para: ${correoDestino}\nPero no está en tu Excel.\n\n🔗 Link: ${elLink}`);
                    }
                }
            }
            // Marcar como leído para no repetir
            await client.messageFlagsAdd(seq, ['\\Seen']);
        }
        await client.logout();
    } catch (e) {
        console.log("❌ Error:", e.message);
        await enviarWA(ADMIN_PHONE, `🚨 *ERROR CRÍTICO*: ${e.message}`);
        if (client) await client.logout().catch(() => {});
    }
}

// Mensaje de inicio
console.log("🚀 Bot de Netflix Iniciado");
enviarWA(ADMIN_PHONE, "🚀 *SISTEMA ACTIVO*\nEl bot de Netflix está encendido y revisando correos cada minuto.");

// Ejecutar
procesarCorreos();
setInterval(procesarCorreos, RECHECK_TIME);
