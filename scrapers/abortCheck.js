// Condiviso tra server e scrapers: permette di interrompere scraping quando l'utente clicca STOP.
let _check = function () { return false; };

function setChecker(fn) {
    if (typeof fn === 'function') _check = fn;
}

function check() {
    return _check();
}

module.exports = { setChecker, check };
