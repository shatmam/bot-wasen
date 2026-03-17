require('dotenv').config();
const { ImapFlow } = require("imapflow");
const { simpleParser } = require('mailparser');
const { google } = require("googleapis");
const fetch = require("node-fetch");

const ADMIN_PHONE = process.env.ADMIN_PHONE; 
const WA_TOKEN = process.env.WA_TOKEN;
const RECHECK_TIME = 1 * 60 * 1000; 

const correosProcesados = new Set();
const enviosRecientes = new Map(); 

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
        const clientesExcel = spreadsheet.data.values || [];

        // Buscamos todos los correos de Netflix (sin límite estricto para no perder ninguno)
        let list = await client.search({ from: "netflix" });
        
        for (let seq of list.slice(-20).reverse()) {
            let meta = await client.fetchOne(seq, { envelope: true });
            let uid = meta.envelope.messageId;

            if (correosProcesados.has(uid)) continue;

            let msg = await client.fetchOne(seq, { source: true });
            let parsed = await simpleParser(msg.source);
            
            // --- LIMPIEZA CRÍTICA DEL HTML ---
            // Quitamos saltos de línea y retornos de carro ANTES de buscar el link
            let htmlLimpio = (parsed.html || parsed.textAsHtml || "").replace(/[\r\n]/g, "");
            let text = (parsed.text || "").replace(/\s+/g, ' '); 
            let correoCuenta = (meta.envelope.to[0].address || "").toLowerCase().trim();

            // 1. IDENTIFICACIÓN PRECISA DEL LINK (Soporta el nftoken gigante)
            const linkMatch = htmlLimpio.match(/href="([^"]*update-primary-location[^"]*)"/i) || 
                              htmlLimpio.match(/href="([^"]*update-home[^"]*)"/i) || 
                              htmlLimpio.match(/href="([^"]*confirm-account[^"]*)"/i) ||
                              htmlLimpio.match(/href="([^"]*netflix.com\/browse[^"]*)"/i);
            
            // Limpieza del link: corregimos &amp; y quitamos espacios que Netflix a veces mete en el HTML
            const elLink = linkMatch ? linkMatch[1].replace(/&amp;/g, "&").replace(/\s/g, "") : null;

            // 2. CAPTURAR EL TEXTO DEL CORREO
            // Buscamos la frase que le dice al usuario qué está pasando
            const cuerpoMatch = text.match(/(Solicitud de.*?)(?=Si no hiciste|$)/i);
            let textoNetflix = cuerpoMatch ? cuerpoMatch[1].trim() : "Se solicitó una actualización de hogar para tu cuenta.";

            // Extraer Perfil para filtrar en el Excel
            const matchPerfil = text.match(/Solicitud de\s+([a-zA-Z0-9áéíóúÁÉÍÓÚñÑ ]+)/i);
            let perfilEncontrado = matchPerfil ? matchPerfil[1].trim() : "DESCONOCIDO";

            if (elLink && perfilEncontrado !== "DESCONOCIDO") {
                const perfilBusqueda = perfilEncontrado.toLowerCase().trim();
                const llaveUnica = `${correoCuenta}-${perfilBusqueda}`;
                const ahora = Date.now();

                // Anti-spam por perfil (3 minutos)
                if (enviosRecientes.has(llaveUnica) && (ahora - enviosRecientes.get(llaveUnica) < 180000)) {
                    correosProcesados.add(uid);
                    continue;
                }

                // Filtrar en Excel por Correo (E) y Perfil (G)
                const coincidencias = clientesExcel.filter(c => 
                    (c[4] || "").toLowerCase().trim() === correoCuenta && 
                    (c[6] || "").toLowerCase().trim() === perfilBusqueda
                );

                if (coincidencias.length > 0) {
                    for (let cliente of coincidencias) {
                        const mensajeFinal = `📺 *NETFLIX ACTUALIZACIÓN*\n\n` +
                            `Hola *${cliente[1]}*,\n\n` +
                            `_${textoNetflix}_\n\n` +
                            `*Usa este link para activar:*\n${elLink}`;
                        
                        await enviarWA(cliente[2], mensajeFinal);
                    }
                    await enviarWA(ADMIN_PHONE, `✅ *ENVIADO*: Perfil "${perfilEncontrado}" de ${correoCuenta}`);
                    enviosRecientes.set(llaveUnica, ahora);
                } else {
                    await enviarWA(ADMIN_PHONE, `⚠️ *PERFIL NO REGISTRADO*: "${perfilEncontrado}" en cuenta ${correoCuenta}. Revisa el Excel.`);
                }
                correosProcesados.add(uid);
            }
        }
        await client.logout();
    } catch (e) {
        if (client) await client.logout().catch(() => {});
    }
}

procesarCorreos();
setInterval(procesarCorreos, RECHECK_TIME);
