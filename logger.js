class Logger {
    constructor() {
        this.clients = [];
    }

    // Add a client response object to the list
    addClient(res) {
        this.clients.push(res);
    }

    // Remove a client
    removeClient(res) {
        this.clients = this.clients.filter(client => client !== res);
    }

    // Send log to all connected clients
    log(message, type = 'info') {
        // Send to SSE clients
        const timestamp = new Date().toISOString();
        const data = JSON.stringify({ message, type, timestamp });
        this.clients.forEach(client => {
            client.write(`data: ${data}\n\n`);
        });
        
        // Log to standard output using process.stdout/stderr directly to avoid recursion with overridden console.log
        const formattedMsg = `[${timestamp}] [${type.toUpperCase()}] ${message}\n`;
        if (type === 'error') {
            process.stderr.write(formattedMsg);
        } else {
            process.stdout.write(formattedMsg);
        }
    }
    
    // Convenience methods
    info(msg) { this.log(msg, 'info'); }
    warn(msg) { this.log(msg, 'warn'); }
    error(msg) { this.log(msg, 'error'); }
    success(msg) { this.log(msg, 'success'); }
}

module.exports = new Logger();
