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
    console.log("🔍 Escaneando perfiles solicitantes...");
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

        let list = await client.search({ from: "netflix" });
        let ultimos = list.slice(-15).reverse();
        
        for (let seq of ultimos) {
            try {
                let msgData = await client.fetchOne(seq, { envelope: true, source: true });
                let msgId = msgData.envelope.messageId;
                let parsed = await simpleParser(msgData.source);
                
                // Limpieza de texto para evitar errores de captura
                let text = (parsed.text || "").replace(/\s+/g, ' '); 
                let correoCuenta = (msgData.envelope.to[0].address || "").toLowerCase().trim();

                // 🔥 CAMBIO CLAVE: Prioridad absoluta a "Solicitud de [Perfil]"
                // Buscamos primero el perfil que pide, no a quien saludan.
                const matchSolicitud = text.match(/Solicitud de\s+([a-zA-Z0-9áéíóúÁÉÍÓÚñÑ ]+)/i);
                
                let perfilDelCorreo = null;
                if (matchSolicitud) {
                    perfilDelCorreo = matchSolicitud[1].trim();
                } else {
                    // Si no dice "Solicitud de", buscamos el saludo como plan B
                    const matchHola = text.match(/Hola,\s*([^:]+):/i);
                    if (matchHola) perfilDelCorreo = matchHola[1].trim();
                }

                if (perfilDelCorreo) {
                    const perfilBusqueda = perfilDelCorreo.toLowerCase().trim();
                    const llaveProcesado = `${msgId}-${perfilBusqueda}`;
                    const llaveSpam = `${correoCuenta}-${perfilBusqueda}`;
                    const ahora = Date.now();

                    if (correosProcesados.has(llaveProcesado)) continue;

                    if (enviosRecientes.has(llaveSpam) && (ahora - enviosRecientes.get(llaveSpam) < 300000)) {
                        correosProcesados.add(llaveProcesado);
                        continue;
                    }

                    // Buscamos en el Excel que coincida Correo (Columna E/Index 4) y Perfil (Columna G/Index 6)
                    const coincidencias = clientes.filter(c => 
                        (c[4] || "").toLowerCase().trim() === correoCuenta && 
                        (c[6] || "").toLowerCase().trim() === perfilBusqueda
                    );

                    if (coincidencias.length > 0) {
                        for (let cliente of coincidencias) {
                            const msjCliente = `📺 *ACTUALIZACIÓN NETFLIX*\n\n` +
                                `Hola *${cliente[1]}*, se detectó una solicitud para el perfil: *${perfilDelCorreo}*.\n\n` +
                                `👉 *Obtén tu código aquí:* \nhttps://codigos-production.up.railway.app/`;
                            
                            await enviarWA(cliente[2], msjCliente);
                            console.log(`✅ Enviado a perfil: ${perfilDelCorreo}`);
                        }
                        enviosRecientes.set(llaveSpam, ahora); 
                    } else {
                        console.log(`⚠️ Perfil "${perfilDelCorreo}" no coincide con el Excel para la cuenta ${correoCuenta}`);
                    }
                    correosProcesados.add(llaveProcesado);
                }
            } catch (err) {
                console.log("⚠️ Error en correo, saltando...");
            }
        }
    } catch (e) {
        console.error("❌ Error General:", e.message);
    } finally {
        await client.logout().catch(() => {});
    }
}

procesarCorreos();
setInterval(procesarCorreos, RECHECK_TIME);
