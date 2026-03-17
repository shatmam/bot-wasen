require('dotenv').config();
const { ImapFlow } = require("imapflow");
const { simpleParser } = require('mailparser');
const { google } = require("googleapis");
const fetch = require("node-fetch");

const ADMIN_PHONE = process.env.ADMIN_PHONE; 
const WA_TOKEN = process.env.WA_TOKEN;
const RECHECK_TIME = 1 * 60 * 1000; 

// Esta memoria evita duplicados en la misma sesión
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
    } catch (e) { console.log("❌ Error enviando WhatsApp:", e.message); }
}

async function procesarCorreos() {
    console.log("--- 🚀 Iniciando Escaneo de Bandeja ---");
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

        // Buscamos los correos de Netflix
        let list = await client.search({ from: "netflix" });
        let ultimosCorreos = list.slice(-15); // Los 15 más nuevos
        
        console.log(`Bandeja analizada. Encontrados ${ultimosCorreos.length} correos potenciales.`);

        for (let seq of ultimosCorreos.reverse()) {
            try {
                let msgData = await client.fetchOne(seq, { envelope: true, source: true });
                let uid = msgData.envelope.messageId;

                // Si ya lo enviamos antes, pasamos al siguiente inmediatamente
                if (correosProcesados.has(uid)) {
                    console.log(`⏭️ Correo ${uid} ya procesado anteriormente. saltando...`);
                    continue;
                }

                let parsed = await simpleParser(msgData.source);
                let text = (parsed.text || "").replace(/\s+/g, ' '); 
                let subject = (msgData.envelope.subject || "").toLowerCase();
                let correoCuenta = (msgData.envelope.to[0].address || "").toLowerCase().trim();

                // Filtro de palabras clave
                const esHogar = text.includes("hogar") || subject.includes("hogar") || text.includes("update-home");
                const esTemporal = text.includes("temporal") || subject.includes("temporal") || text.includes("código");

                if (esHogar || esTemporal) {
                    const matchSolicitud = text.match(/Solicitud de\s+([a-zA-Z0-9áéíóúÁÉÍÓÚñÑ ]+)/i);
                    const matchHola = text.match(/Hola,\s*([^:]+):/i);
                    let perfilDelCorreo = matchSolicitud ? matchSolicitud[1].trim() : (matchHola ? matchHola[1].trim() : null);

                    if (perfilDelCorreo) {
                        const perfilBusqueda = perfilDelCorreo.toLowerCase().trim();
                        const llaveSpam = `${correoCuenta}-${perfilBusqueda}`;
                        const ahora = Date.now();

                        // Anti-Spam: No enviar al mismo perfil más de una vez cada 5 min
                        if (enviosRecientes.has(llaveSpam) && (ahora - enviosRecientes.get(llaveSpam) < 300000)) {
                            console.log(`⏳ Perfil ${perfilDelCorreo} en espera por antispam.`);
                            correosProcesados.add(uid);
                            continue;
                        }

                        const coincidencias = clientes.filter(c => 
                            (c[4] || "").toLowerCase().trim() === correoCuenta && 
                            (c[6] || "").toLowerCase().trim() === perfilBusqueda
                        );

                        if (coincidencias.length > 0) {
                            for (let cliente of coincidencias) {
                                const msjCliente = `📺 *ACTUALIZACIÓN NETFLIX*\n\n` +
                                    `Hola *${cliente[1]}*, detectamos una solicitud para tu perfil *${perfilDelCorreo}*.\n\n` +
                                    `👉 *Obtén tu código aquí:* \nhttps://codigos-production.up.railway.app/`;
                                
                                await enviarWA(cliente[2], msjCliente);
                                console.log(`📧 WhatsApp enviado a: ${cliente[1]} (${perfilDelCorreo})`);
                            }
                            enviosRecientes.set(llaveSpam, ahora); 
                        } else {
                            console.log(`❓ Solicitud detectada pero perfil "${perfilDelCorreo}" no está en el Excel.`);
                        }
                        // Importante: Marcar como procesado para que no se repita en el próximo ciclo
                        correosProcesados.add(uid);
                    }
                }
            } catch (err) {
                console.log("⚠️ Error procesando un mensaje específico:", err.message);
            }
        }
    } catch (e) {
        console.error("❌ ERROR GENERAL:", e.message);
    } finally {
        await client.logout().catch(() => {});
        console.log("--- ✅ Ciclo Terminado ---");
    }
}

procesarCorreos();
setInterval(procesarCorreos, RECHECK_TIME);
