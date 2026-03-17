require('dotenv').config();
const express = require("express");
const path = require("path");
const { ImapFlow } = require("imapflow");
const { simpleParser } = require('mailparser');
const { google } = require("googleapis");
const fetch = require("node-fetch");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));

// ================= CONFIGURACIÓN =================
const EMAIL_USER = process.env.EMAIL_USER; 
const EMAIL_PASS = process.env.EMAIL_PASS; 
const SPREADSHEET_ID = process.env.SPREADSHEET_ID; 
const WA_TOKEN = process.env.WA_TOKEN; 
const ADMIN_PHONE = process.env.ADMIN_PHONE; 

async function enviarWA(tel, msj) {
    try {
        let numero = tel.toString().replace(/[^0-9]/g, "");
        // Asegurar formato internacional sin el "+" (Wasender estándar)
        if (!numero.startsWith("1") && numero.length === 10) numero = "1" + numero;
        
        console.log(`Intentando enviar a: ${numero}`);

        const response = await fetch("https://www.wasenderapi.com/api/send-message", {
            method: "POST",
            headers: { 
                "Authorization": `Bearer ${WA_TOKEN}`, 
                "Content-Type": "application/json" 
            },
            body: JSON.stringify({ 
                to: numero, 
                text: msj 
            })
        });
        
        const resData = await response.json();
        console.log("Resultado API WhatsApp:", resData);
    } catch (e) { 
        console.log("❌ Error WA:", e.message); 
    }
}

app.get("/api/emails", async (req, res) => {
    const client = new ImapFlow({
        host: "imap.gmail.com", port: 993, secure: true,
        auth: { user: EMAIL_USER, pass: EMAIL_PASS },
        logger: false, tls: { rejectUnauthorized: false }
    });

    try {
        await client.connect();
        await client.mailboxOpen('INBOX');

        let todosLosClientes = [];
        try {
            const auth = new google.auth.GoogleAuth({
                credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
                scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"]
            });
            const sheets = google.sheets({ version: "v4", auth });
            const spreadsheet = await sheets.spreadsheets.values.get({ 
                spreadsheetId: SPREADSHEET_ID, 
                range: "Clientes!A2:K1000" 
            });
            todosLosClientes = spreadsheet.data.values || [];
            console.log(`Clientes cargados: ${todosLosClientes.length}`);
        } catch (e) { 
            console.log("Error Sheets:", e.message);
            await enviarWA(ADMIN_PHONE, `❌ ERROR GOOGLE SHEETS: ${e.message}`);
        }
        
        let emailsParaMostrar = [];
        // Buscamos correos de Netflix
        let list = await client.search({ from: "netflix" });
        console.log(`Correos encontrados: ${list.length}`);

        // Revisamos los últimos 15 correos para mayor margen
        for (let seq of list.slice(-15).reverse()) {
            let msg = await client.fetchOne(seq, { source: true, envelope: true });
            let subject = (msg.envelope.subject || "").toLowerCase();
            let parsed = await simpleParser(msg.source);
            let contenido = (parsed.text || "").toLowerCase();
            let htmlOriginal = parsed.html || parsed.textAsHtml || "";

            const esCorreoDeCambio = subject.includes("cambio") || subject.includes("cuenta") || subject.includes("contraseña") || subject.includes("password") || subject.includes("sesión") || contenido.includes("cambiar la información") || contenido.includes("restablecer tu contraseña");
            const esAccesoUtil = subject.includes("código") || subject.includes("codigo") || subject.includes("temporal") || subject.includes("hogar") || subject.includes("viaje");

            if (esAccesoUtil && !esCorreoDeCambio) {
                const correoDestino = (msg.envelope.to[0].address || "").toLowerCase().trim();
                
                const linkMatch = htmlOriginal.match(/href="([^"]*update-home[^"]*)"/) || 
                                  htmlOriginal.match(/href="([^"]*confirm-account[^"]*)"/) ||
                                  htmlOriginal.match(/href="([^"]*netflix.com\/browse[^"]*)"/);
                const elLink = linkMatch ? linkMatch[1] : null;

                if (elLink) {
                    console.log(`Link encontrado para: ${correoDestino}`);
                    let clientesMatch = todosLosClientes.filter(f => (f[4] || "").toLowerCase().trim() === correoDestino);
                    
                    if (clientesMatch.length > 0) {
                        for (let c of clientesMatch) {
                            const msj = `🏠 *ACTUALIZACIÓN NETFLIX*\n\nHola *${c[1]}*, pulsa el botón para activar tu TV:\n\n${elLink}`;
                            await enviarWA(c[2], msj);
                        }
                    } else {
                        const msjAdmin = `⚠️ *CUENTA NO ENCONTRADA*\n\nCorreo: ${correoDestino}\nLink: ${elLink}`;
                        await enviarWA(ADMIN_PHONE, msjAdmin);
                    }
                }

                const fechaRD = new Date(msg.envelope.date).toLocaleString('es-DO', {
                    timeZone: 'America/Santo_Domingo', hour: '2-digit', minute: '2-digit', hour12: true
                });

                emailsParaMostrar.push({ subject: msg.envelope.subject, date: fechaRD, to: correoDestino, html: htmlOriginal });
            }
        }
        await client.logout();
        res.json({ emails: emailsParaMostrar });
    } catch (error) {
        console.log("Error en el proceso:", error.message);
        if (client) await client.logout().catch(() => {});
        res.status(500).json({ error: "Error" });
    }
});

app.listen(PORT, '0.0.0.0', () => { console.log("🚀 Monitor de Diagnóstico activo"); });
