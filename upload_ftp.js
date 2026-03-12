const ftp = require("basic-ftp")
const fs = require("fs")
const path = require("path")
require("dotenv").config()

async function uploadToFTP() {
    const client = new ftp.Client()
    client.ftp.verbose = true

    try {
        console.log("Connessione al server FTP...")
        await client.access({
            host: process.env.FTP_HOST,
            user: process.env.FTP_USER,
            password: process.env.FTP_PASSWORD,
            secure: false // Imposta true se usi FTPS
        })

        const localDir = path.join(__dirname, "Client")
        const remoteDir = process.env.FTP_REMOTE_DIR || "/"

        console.log(`Caricamento file da ${localDir} a ${remoteDir}...`)
        
        // Carica l'intera cartella Client ricorsivamente
        await client.uploadFromDir(localDir, remoteDir)

        console.log("Upload completato con successo!")
    } catch (err) {
        console.error("Errore durante l'upload:", err)
    } finally {
        client.close()
    }
}

uploadToFTP()
