require('dotenv').config();
const { ImapFlow } = require("imapflow");
const { simpleParser } = require('mailparser');
const { google } = require("googleapis");
const fetch = require("node-fetch");

// Configuración desde Variables de Entorno
const ADMIN_PHONE = process.env.ADMIN_PHONE; 
const WA_TOKEN = process.env.WA_TOKEN;
const RECHECK_TIME = 1 * 60 * 1000; 

const correosProcesados = new Set();
let botIniciado = false;

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
        const clientes = spreadsheet.data.values || [];

        if (!botIniciado) {
            await enviarWA(ADMIN_PHONE, `✅ *SISTEMA VINCULADO*\nLink extraído de HTML activo.\nClientes: ${clientes.length}`);
            botIniciado = true;
        }

        let list = await client.search({ from: "netflix" });
        // Revisamos los últimos 5 para asegurar que no se escape ninguno
        for (let seq of list.slice(-5).reverse()) {
            if (correosProcesados.has(seq)) continue;

            let msg = await client.fetchOne(seq, { source: true, envelope: true });
            let parsed = await simpleParser(msg.source);
            let htmlOriginal = parsed.html || parsed.textAsHtml || "";
            let text = (parsed.text || "").replace(/\s+/g, ' '); 
            let correoCuenta = (msg.envelope.to[0].address || "").toLowerCase().trim();

            // 1. EXTRAER LINK (Lógica del código que me pasaste)
            const linkMatch = htmlOriginal.match(/href="([^"]*update-home[^"]*)"/) || 
                              htmlOriginal.match(/href="([^"]*confirm-account[^"]*)"/) ||
                              htmlOriginal.match(/href="([^"]*netflix.com\/browse[^"]*)"/);
            const elLink = linkMatch ? linkMatch[1] : null;

            // 2. EXTRAER PERFIL (Prioridad a "Solicitud de")
            const matchSolicitud = text.match(/Solicitud de\s+([a-zA-Z0-9áéíóúÁÉÍÓÚñÑ]+)/i);
            const matchHola = text.match(/Hola,\s*([^:]+):/i);
            let perfilDelCorreo = matchSolicitud ? matchSolicitud[1].trim() : (matchHola ? matchHola[1].trim() : "DESCONOCIDO");

            // Reporte Admin para verificar en tiempo real
            await enviarWA(ADMIN_PHONE, `📩 *REVISANDO*\n📧: ${correoCuenta}\n👤: "${perfilDelCorreo}"\n🔗: ${elLink ? "✅ LISTO" : "❌ FALLÓ"}`);

            if (elLink && perfilDelCorreo !== "DESCONOCIDO") {
                // Buscamos en el Excel (Columna E para correo, Columna G para perfil)
                const cliente = clientes.find(c => 
                    (c[4] || "").toLowerCase().trim() === correoCuenta && 
                    (c[6] || "").toLowerCase().trim() === perfilDelCorreo.toLowerCase()
                );

                if (cliente) {
                    const msjCliente = `🏠 *ACTUALIZACIÓN NETFLIX*\n\nHola *${cliente[1]}*, pulsa el botón para activar tu TV:\n\n${elLink}`;
                    await enviarWA(cliente[2], msjCliente);
                    await enviarWA(ADMIN_PHONE, `✅ *ENVIADO A*: ${cliente[1]} (Perfil ${perfilDelCorreo})`);
                } else {
                    await enviarWA(ADMIN_PHONE, `⚠️ *SIN COINCIDENCIA*: Perfil "${perfilDelCorreo}" no encontrado para ${correoCuenta} en Excel.`);
                }
            }
            correosProcesados.add(seq);
        }
        await client.logout();
    } catch (e) {
        if (client) await client.logout().catch(() => {});
    }
}

// Ejecución inicial y ciclo de 1 minuto
procesarCorreos();
setInterval(procesarCorreos, RECHECK_TIME);
