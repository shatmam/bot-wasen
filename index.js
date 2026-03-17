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

// Limpia el perfil para que coincida con tu Columna G del Excel
function limpiarPerfil(texto) {
    if (!texto) return "";
    let soloNumeros = texto.replace(/\D/g, "");
    return soloNumeros !== "" ? soloNumeros : texto.toLowerCase().trim();
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
            await enviarWA(ADMIN_PHONE, `🚀 *BOT MAESTRO ACTIVO*\nValidando 86 clientes con Doble/Triple Clic Automático.`);
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

            // 1. Extraer Link (Buscador agresivo de botones)
            const linkMatch = htmlOriginal.match(/href="([^"]*pin-code[^"]*)"/) || 
                              htmlOriginal.match(/href="([^"]*update-home[^"]*)"/) || 
                              htmlOriginal.match(/href="([^"]*confirm-account[^"]*)"/);
            let elLink = linkMatch ? linkMatch[1].replace(/&amp;/g, "&") : null;

            // 2. Extraer Perfil (Solicitud de... o Hola, ...)
            const matchPerfil = text.match(/Solicitud de ([^ ]+)/i) || text.match(/Hola, ([^:]+):/i);
            let perfilNombre = matchPerfil ? matchPerfil[1].trim() : "DESCONOCIDO";

            if (elLink && perfilNombre !== "DESCONOCIDO") {
                let codigoFinal = null;
                try {
                    // --- PASO DE NAVEGACIÓN (LOS CLICKS) ---
                    // Clic 1: Entrar al link del correo
                    let res1 = await fetch(elLink, { headers: { 'User-Agent': 'Mozilla/5.0' }, redirect: 'follow' });
                    let htmlPaso2 = await res1.text();

                    // Clic 2: Buscar botón de confirmación o "Enviar código"
                    const confirmMatch1 = htmlPaso2.match(/href="([^"]*update-home-confirmed[^"]*)"/) || 
                                          htmlPaso2.match(/href="([^"]*send-code[^"]*)"/) ||
                                          htmlPaso2.match(/href="([^"]*verify-device[^"]*)"/);
                    
                    if (confirmMatch1) {
                        let res2 = await fetch(confirmMatch1[1], { headers: { 'User-Agent': 'Mozilla/5.0' }, redirect: 'follow' });
                        let htmlPaso3 = await res2.text();
                        
                        // Intentar extraer el código de 4 dígitos de la página final si existe
                        const pinMatch = htmlPaso3.match(/>(\d{4})</) || htmlPaso3.match(/\b\d{4}\b/);
                        codigoFinal = pinMatch ? pinMatch[1] : null;
                    }
                } catch (err) { console.log("Error en flujo de clics:", err.message); }

                // 3. Buscar cliente y enviar resultado
                const cliente = todosLosClientes.find(fila => {
                    let correoFila = (fila[4] || "").toLowerCase().trim();
                    let perfilFila = limpiarPerfil(fila[6]);
                    return correoFila === correoCuenta && perfilFila === limpiarPerfil(perfilNombre);
                });

                if (cliente) {
                    if (codigoFinal) {
                        await enviarWA(cliente[2], `🔑 *TU CÓDIGO NETFLIX*\n\nHola *${cliente[1]}*, tu código de acceso es: *${codigoFinal}*`);
                    } else {
                        await enviarWA(cliente[2], `✅ *ACCESO AUTORIZADO*\n\nHola *${cliente[1]}*, ya validamos tu solicitud para el perfil *${perfilNombre}*.\nYa puedes entrar a disfrutar. 🍿`);
                    }
                    await enviarWA(ADMIN_PHONE, `✨ *ÉXITO*: ${cliente[1]} (${perfilNombre}) procesado.`);
                }
            }
            correosProcesados.add(seq);
        }
        await client.logout();
    } catch (e) { if (client) await client.logout().catch(() => {}); }
}

procesarCorreos();
setInterval(procesarCorreos, RECHECK_TIME);
