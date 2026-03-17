require('dotenv').config();
const { ImapFlow } = require("imapflow");
const { simpleParser } = require('mailparser');
const { google } = require("googleapis");
const fetch = require("node-fetch");

const ADMIN_PHONE = process.env.ADMIN_PHONE; 
const WA_TOKEN = process.env.WA_TOKEN;
const RECHECK_TIME = 1 * 60 * 1000; 

const correosProcesados = new Set();
let botIniciado = false;

// Limpieza para comparar perfil (Columna G)
function limpiarPerfil(texto) {
    if (!texto) return "";
    return texto.replace(/Solicitud de/i, "").trim().toLowerCase();
}

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
        const todosLosClientes = spreadsheet.data.values || [];

        if (!botIniciado) {
            await enviarWA(ADMIN_PHONE, `✅ *BOT DE ENVÍO DIRECTO ACTIVO*\nEnviando links a clientes según su perfil.`);
            botIniciado = true;
        }

        let list = await client.search({ from: "netflix" });

        for (let seq of list.slice(-5).reverse()) {
            if (correosProcesados.has(seq)) continue;

            let msg = await client.fetchOne(seq, { source: true, envelope: true });
            let parsed = await simpleParser(msg.source);
            let htmlOriginal = parsed.html || "";
            let text = (parsed.text || "").replace(/\s+/g, ' '); 
            let correoCuenta = (msg.envelope.to[0].address || "").toLowerCase().trim();

            // 1. Extraer Link
            const linkMatch = htmlOriginal.match(/href="([^"]*pin-code[^"]*)"/) || 
                              htmlOriginal.match(/href="([^"]*update-home[^"]*)"/) || 
                              htmlOriginal.match(/href="([^"]*confirm-account[^"]*)"/);
            
            let elLink = linkMatch ? linkMatch[1].replace(/&amp;/g, "&") : null;

            // 2. Extraer Perfil
            const matchPerfil = text.match(/Solicitud de ([^ ]+)/i) || text.match(/Hola, ([^:]+):/i);
            let perfilNombre = matchPerfil ? matchPerfil[1].trim() : "DESCONOCIDO";

            if (elLink && perfilNombre !== "DESCONOCIDO") {
                const perfilBusqueda = limpiarPerfil(perfilNombre);

                // 3. Buscar en Excel (Mismo Correo + Mismo Perfil)
                const cliente = todosLosClientes.find(fila => {
                    let correoFila = (fila[4] || "").toLowerCase().trim();
                    let perfilFila = limpiarPerfil(fila[6] || "");
                    return correoFila === correoCuenta && perfilFila === perfilBusqueda;
                });

                if (cliente) {
                    // 4. Enviar link al cliente
                    const mensaje = `🏠 *SOLICITUD NETFLIX*\n\nHola *${cliente[1]}*, detectamos tu solicitud en el perfil *${perfilNombre}*.\n\nPulsa el botón de abajo para activar tu acceso:\n${elLink}`;
                    await enviarWA(cliente[2], mensaje);
                    
                    // Reporte al Admin
                    await enviarWA(ADMIN_PHONE, `✅ *LINK ENVIADO*: ${cliente[1]} (${perfilNombre}) recibio su link de activación.`);
                } else {
                    await enviarWA(ADMIN_PHONE, `⚠️ *NO ENCONTRADO*: Se recibió solicitud de "${perfilNombre}" en ${correoCuenta}, pero no está en el Excel.`);
                }
            }
            correosProcesados.add(seq);
        }
        await client.logout();
    } catch (e) { if (client) await client.logout().catch(() => {}); }
}

procesarCorreos();
setInterval(procesarCorreos, RECHECK_TIME);
