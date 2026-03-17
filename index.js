require('dotenv').config();
const { ImapFlow } = require("imapflow");
const { simpleParser } = require('mailparser');
const { google } = require("googleapis");
const fetch = require("node-fetch");

// 🔥 NUEVO
const PDFDocument = require("pdfkit");
const fs = require("fs");
const FormData = require("form-data");

const ADMIN_PHONE = process.env.ADMIN_PHONE; 
const WA_TOKEN = process.env.WA_TOKEN;
const RECHECK_TIME = 1 * 60 * 1000; 

const correosProcesados = new Set();
const enviosRecientes = new Map();

// 🔥 CREAR PDF
async function crearPDF(contenido, nombreArchivo) {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument();
        const stream = fs.createWriteStream(nombreArchivo);

        doc.pipe(stream);

        doc.fontSize(16).text("📩 NETFLIX", { align: "center" });
        doc.moveDown();
        doc.fontSize(12).text(contenido, {
            align: "left"
        });

        doc.end();

        stream.on("finish", () => resolve(nombreArchivo));
        stream.on("error", reject);
    });
}

// 🔥 ENVIAR PDF
async function enviarPDF(tel, archivo) {
    try {
        let numero = tel.toString().replace(/[^0-9]/g, "");
        if (!numero.startsWith("1") && numero.length === 10) numero = "1" + numero;

        const form = new FormData();
        form.append("to", "+" + numero);
        form.append("file", fs.createReadStream(archivo));
        form.append("caption", "📩 Correo de Netflix");

        await fetch("https://www.wasenderapi.com/api/send-file", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${WA_TOKEN}`,
                ...form.getHeaders()
            },
            body: form
        });

    } catch (e) {
        console.log("❌ Error enviando PDF:", e.message);
    }
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

        let list = await client.search({ from: "netflix" });
        
        for (let seq of list.slice(-10).reverse()) {

            let meta = await client.fetchOne(seq, { envelope: true });
            let uid = meta.envelope.messageId;

            if (correosProcesados.has(uid)) continue;

            let msg = await client.fetchOne(seq, { source: true });
            let parsed = await simpleParser(msg.source);

            let text = (parsed.text || "").replace(/\s+/g, ' '); 
            let correoCuenta = (meta.envelope.to[0].address || "").toLowerCase().trim();

            const matchSolicitud = text.match(/Solicitud de\s+([a-zA-Z0-9áéíóúÁÉÍÓÚñÑ ]+)/i);
            const matchHola = text.match(/Hola,\s*([^:]+):/i);

            let perfilDelCorreo = matchSolicitud 
                ? matchSolicitud[1].trim() 
                : (matchHola ? matchHola[1].trim() : "DESCONOCIDO");

            if (parsed.text && perfilDelCorreo !== "DESCONOCIDO") {

                const perfilBusqueda = perfilDelCorreo.toLowerCase().trim();
                const llaveSpam = `${correoCuenta}-${perfilBusqueda}`;
                const ahora = Date.now();

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

                        const contenidoCorreo = parsed.text || "No se pudo leer el correo";

                        const nombreArchivo = `correo-${Date.now()}.pdf`;

                        await crearPDF(contenidoCorreo, nombreArchivo);

                        await enviarPDF(cliente[2], nombreArchivo);

                        // borrar PDF después de enviar
                        fs.unlinkSync(nombreArchivo);
                    }

                    console.log(`✅ PDF enviado a ${perfilDelCorreo}`);
                    enviosRecientes.set(llaveSpam, ahora);
                }

                correosProcesados.add(uid);
            }
        }

        await client.logout();

    } catch (e) {
        console.log("❌ ERROR:", e.message);
        if (client) await client.logout().catch(() => {});
    }
}

procesarCorreos();
setInterval(procesarCorreos, RECHECK_TIME);
