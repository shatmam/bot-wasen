require('dotenv').config();
const { ImapFlow } = require("imapflow");
const { simpleParser } = require('mailparser');
const { google } = require("googleapis");
const fetch = require("node-fetch");

const ADMIN_PHONE = process.env.ADMIN_PHONE; 
const WA_TOKEN = process.env.WA_TOKEN;
const RECHECK_TIME = 1 * 60 * 1000; // 1 minuto entre chequeos

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
    console.log("🔍 Escaneando últimos 15 correos de Netflix...");
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

        // Buscamos correos de Netflix (leídos y no leídos)
        let list = await client.search({ from: "netflix" });
        
        // Tomamos los últimos 15 correos para asegurar que no se pierda nada
        for (let seq of list.slice(-15).reverse()) {
            try {
                let meta = await client.fetchOne(seq, { envelope: true });
                let uid = meta.envelope.messageId;

                // SI YA SE PROCESÓ EN ESTA SESIÓN, SALTAR
                if (correosProcesados.has(uid)) continue;

                let msg = await client.fetchOne(seq, { source: true });
                let parsed = await simpleParser(msg.source);
                let text = (parsed.text || "").replace(/\s+/g, ' '); 
                let subject = (meta.envelope.subject || "").toLowerCase();
                let correoCuenta = (meta.envelope.to[0].address || "").toLowerCase().trim();

                // FILTRO: Solo procesar si es Hogar o Acceso Temporal
                const esHogar = text.includes("hogar") || subject.includes("hogar");
                const esTemporal = text.includes("temporal") || subject.includes("temporal");

                if (esHogar || esTemporal) {
                    const matchSolicitud = text.match(/Solicitud de\s+([a-zA-Z0-9áéíóúÁÉÍÓÚñÑ ]+)/i);
                    const matchHola = text.match(/Hola,\s*([^:]+):/i);
                    let perfilDelCorreo = matchSolicitud ? matchSolicitud[1].trim() : (matchHola ? matchHola[1].trim() : null);

                    if (perfilDelCorreo) {
                        const perfilBusqueda = perfilDelCorreo.toLowerCase().trim();
                        const llaveSpam = `${correoCuenta}-${perfilBusqueda}`;
                        const ahora = Date.now();

                        // ANTISPAM: 5 minutos por perfil
                        if (enviosRecientes.has(llaveSpam) && (ahora - enviosRecientes.get(llaveSpam) < 300000)) {
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
                                    `Hola *${cliente[1]}*, detectamos una solicitud de *Hogar o Acceso Temporal* para tu perfil *${perfilDelCorreo}*.\n\n` +
                                    `👉 *Obtén tu código aquí:* \nhttps://codigos-production.up.railway.app/`;
                                
                                await enviarWA(cliente[2], msjCliente);
                            }
                            console.log(`✅ Notificado: ${perfilDelCorreo} (${correoCuenta})`);
                            enviosRecientes.set(llaveSpam, ahora); 
                        }
                        // Marcamos como procesado para no repetir
                        correosProcesados.add(uid);
                    }
                }
            } catch (err) {
                console.log("⚠️ Error en correo individual, continuando...");
            }
        }
    } catch (e) {
        console.error("❌ ERROR CRÍTICO:", e.message);
    } finally {
        await client.logout().catch(() => {});
        console.log("💤 Ciclo completado.");
    }
}

procesarCorreos();
setInterval(procesarCorreos, RECHECK_TIME);
