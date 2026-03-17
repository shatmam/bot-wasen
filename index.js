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

// Compara perfiles limpiando basura (ej: "Perfil 1" y "1" son iguales)
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
            await enviarWA(ADMIN_PHONE, `🚀 *BOT VALIDANDO ACTIVACIONES*\nMonitoreando 86 clientes.\nEstado: Listo.`);
            botIniciado = true;
        }

        let list = await client.search({ from: "netflix" });

        for (let seq of list.slice(-5).reverse()) {
            if (correosProcesados.has(seq)) continue;

            let msg = await client.fetchOne(seq, { source: true, envelope: true });
            let parsed = await simpleParser(msg.source);
            let htmlOriginal = parsed.html || parsed.textAsHtml || "";
            let text = (parsed.text || "").replace(/\s+/g, ' '); 
            let correoCuenta = (msg.envelope.to[0].address || "").toLowerCase().trim();

            const linkMatch = htmlOriginal.match(/href="([^"]*update-home[^"]*)"/) || 
                              htmlOriginal.match(/href="([^"]*confirm-account[^"]*)"/) ||
                              htmlOriginal.match(/href="([^"]*nm_hp[^"]*)"/);
            
            let elLink = linkMatch ? linkMatch[1].replace(/&amp;/g, "&") : null;

            const matchSolicitud = text.match(/Solicitud de\s+([a-zA-Z0-9áéíóúÁÉÍÓÚñÑ]+)/i);
            const matchHola = text.match(/Hola,\s*([^:]+):/i);
            let perfilNombre = matchSolicitud ? matchSolicitud[1].trim() : (matchHola ? matchHola[1].trim() : null);

            if (elLink && perfilNombre) {
                // 🛠️ FUNCIÓN DE AUTO-PULSADO (Simula el clic del cliente)
                try {
                    const response = await fetch(elLink, { 
                        method: 'GET', 
                        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
                        redirect: 'follow' // Importante: Sigue el link hasta el final
                    });
                    console.log(`✅ Click automático realizado para ${perfilNombre}`);
                } catch (err) { console.log(`⚠️ Error al pulsar link: ${err.message}`); }

                const perfilBusqueda = limpiarPerfil(perfilNombre);

                const cliente = todosLosClientes.find(fila => {
                    let correoFila = (fila[4] || "").toLowerCase().trim();
                    let perfilFila = limpiarPerfil(fila[6]);
                    return correoFila === correoCuenta && perfilFila === perfilBusqueda;
                });

                if (cliente) {
                    const mensaje = `🏠 *NETFLIX ACTUALIZADO*\n\nHola *${cliente[1]}*, ya procesamos tu solicitud para el perfil *${perfilNombre}*.\n\n*Nota:* Si tu TV aún te pide confirmar, pulsa este link manualmente:\n${elLink}`;
                    
                    await enviarWA(cliente[2], mensaje);
                    await enviarWA(ADMIN_PHONE, `✅ *PROCESADO*: ${cliente[1]} (${perfilNombre})`);
                } else {
                    await enviarWA(ADMIN_PHONE, `⚠️ *SIN REGISTRO*: Perfil "${perfilNombre}" en ${correoCuenta} no existe en Excel.`);
                }
            }
            correosProcesados.add(seq);
        }
        await client.logout();
    } catch (e) { if (client) await client.logout().catch(() => {}); }
}

procesarCorreos();
setInterval(procesarCorreos, RECHECK_TIME);
