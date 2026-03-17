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
    console.log("🔍 Escaneando perfiles (Modo Multi-Envío)...");
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
                let text = (parsed.text || "").replace(/\s+/g, ' '); 
                let correoCuenta = (msgData.envelope.to[0].address || "").toLowerCase().trim();

                // 1. BUSCAMOS TODOS LOS PERFILES EN EL MISMO CORREO
                const regexPerfil = /Solicitud de\s+([a-zA-Z0-9áéíóúÁÉÍÓÚñÑ ]+)/gi;
                const matches = [...text.matchAll(regexPerfil)];
                
                // Si no encuentra con "Solicitud de", intentamos con el saludo
                if (matches.length === 0) {
                    const matchHola = text.match(/Hola,\s*([^:]+):/i);
                    if (matchHola) matches.push([null, matchHola[1]]);
                }

                for (const match of matches) {
                    let perfilNombre = match[1].trim();
                    let perfilBusqueda = perfilNombre.toLowerCase();
                    
                    // Identificador único para NO repetir este perfil de este correo específico
                    const llaveUnica = `${msgId}-${perfilBusqueda}`;
                    const llaveSpam = `${correoCuenta}-${perfilBusqueda}`;
                    const ahora = Date.now();

                    if (correosProcesados.has(llaveUnica)) continue;

                    // Filtro 5 minutos por perfil/cuenta
                    if (enviosRecientes.has(llaveSpam) && (ahora - enviosRecientes.get(llaveSpam) < 300000)) {
                        continue;
                    }

                    // Buscamos en el Excel
                    const coincidencias = clientes.filter(c => 
                        (c[4] || "").toLowerCase().trim() === correoCuenta && 
                        (c[6] || "").toLowerCase().trim() === perfilBusqueda
                    );

                    if (coincidencias.length > 0) {
                        for (let cliente of coincidencias) {
                            const msjCliente = `📺 *ACTUALIZACIÓN NETFLIX*\n\n` +
                                `Hola *${cliente[1]}*, se solicitó acceso para el perfil: *${perfilNombre}*.\n\n` +
                                `👉 *Obtén tu código aquí:* \nhttps://codigos-production.up.railway.app/`;
                            
                            await enviarWA(cliente[2], msjCliente);
                            console.log(`✅ Enviado WhatsApp a: ${perfilNombre} de ${correoCuenta}`);
                        }
                        enviosRecientes.set(llaveSpam, ahora);
                    } else {
                        console.log(`⚠️ No coincide: [${perfilNombre}] en cuenta [${correoCuenta}]`);
                    }
                    
                    // Guardamos que este perfil de este correo ya se procesó
                    correosProcesados.add(llaveUnica);
                }
            } catch (err) {
                console.log("⚠️ Error procesando un correo, saltando...");
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
