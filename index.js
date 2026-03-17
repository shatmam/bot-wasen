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
const RECHECK_TIME = 15 * 1000; // 15 segundos

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
    console.log("🔍 Iniciando escaneo profundo...");
    const client = new ImapFlow({
        host: "imap.gmail.com", 
        port: 993, 
        secure: true,
        auth: { user: EMAIL_USER, pass: EMAIL_PASS },
        logger: false, 
        tls: { rejectUnauthorized: false }
    });

    try {
        await client.connect();
        
        // Intentamos abrir "INBOX" pero si no hay nada, podrías cambiarlo a "[Gmail]/Todos"
        await client.mailboxOpen('INBOX');

        // 1. Leer Google Sheets
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
            await enviarWA(ADMIN_PHONE, `🕵️ *BOT EN LINEA*\n📊 Clientes cargados: ${clientes.length}\n⚙️ Escaneando últimos 10 correos...`);
            botIniciado = true;
        }

        // 2. Buscar TODOS los últimos 10 correos (sin filtros de Netflix para ver qué lee)
        let list = await client.search({ all: true });
        let ultimos = list.slice(-10).reverse();

        for (let seq of ultimos) {
            let msg = await client.fetchOne(seq, { source: true, envelope: true });
            let parsed = await simpleParser(msg.source);
            
            let asunto = (msg.envelope.subject || "").toLowerCase();
            let deQuien = (msg.envelope.from[0].address || "").toLowerCase();
            let contenido = (parsed.text || "").toLowerCase();
            let html = parsed.html || parsed.textAsHtml || "";
            let correoCuenta = (msg.envelope.to[0].address || "").toLowerCase().trim();

            // 3. Si detecta Netflix, empezamos el reporte
            if (deQuien.includes("netflix") || asunto.includes("netflix")) {
                
                // Extraer Perfil
                const perfilMatch = contenido.match(/solicitud de\s+([^\n,]+)/i);
                let perfilDelCorreo = perfilMatch ? perfilMatch[1].trim().toLowerCase() : "No detectado";

                // Avisar al Admin que encontró algo
                await enviarWA(ADMIN_PHONE, `📩 *NETFLIX ENCONTRADO*\n📧 Cuenta: ${correoCuenta}\n👤 Perfil en correo: "${perfilDelCorreo}"`);

                // Buscar Link
                const linkMatch = html.match(/href="([^"]*update-home[^"]*)"/) || 
                                 html.match(/href="([^"]*confirm-account[^"]*)"/);

                if (linkMatch) {
                    const elLink = linkMatch[1];
                    
                    // Buscar coincidencia en Excel (Correo Col E + Perfil Col G)
                    const clienteCorrecto = clientes.find(c => {
                        const correoExcel = (c[4] || "").toLowerCase().trim();
                        const perfilExcel = (c[6] || "").toLowerCase().trim();
                        // Match flexible
                        return correoExcel === correoCuenta && 
                               (perfilDelCorreo.includes(perfilExcel) || perfilExcel.includes(perfilDelCorreo));
                    });

                    if (clienteCorrecto) {
                        // Enviar al cliente
                        const msjExito = `🏠 *ACTUALIZACIÓN NETFLIX*\n\nHola *${clienteCorrecto[1]}*, detectamos tu solicitud en el perfil *${perfilDelCorreo.toUpperCase()}*.\n\nActiva aquí:\n${elLink}`;
                        await enviarWA(clienteCorrecto[2], msjExito);
                        
                        // Reportar al Admin
                        await enviarWA(ADMIN_PHONE, `✅ *ENVIADO OK*\nCliente: ${clienteCorrecto[1]}\nPerfil: ${perfilDelCorreo}`);
                    } else {
                        // Reportar porque no hubo match
                        await enviarWA(ADMIN_PHONE, `⚠️ *SIN MATCH EN EXCEL*\nVi el perfil "${perfilDelCorreo}" para ${correoCuenta}, pero no coincide con tu Columna G.`);
                    }
                } else {
                    await enviarWA(ADMIN_PHONE, `❌ *LINK NO ENCONTRADO*\nEncontré el correo pero no el enlace de activación.`);
                }
            }
        }
        await client.logout();
    } catch (e) {
        console.log("Error:", e.message);
        if (client) await client.logout().catch(() => {});
    }
}

// Iniciar ciclo
procesarCorreos();
setInterval(procesarCorreos, RECHECK_TIME);
