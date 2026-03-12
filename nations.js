/**
 * Elenco nomi canonici delle nazioni (italiano) e varianti da normalizzare.
 * In articolielaborati.json si usano solo i nomi canonici.
 */
var canonical = [
    'Afghanistan', 'Albania', 'Algeria', 'Andorra', 'Angola', 'Arabia Saudita',
    'Argentina', 'Armenia', 'Australia', 'Austria', 'Azerbaigian', 'Bahrein',
    'Bangladesh', 'Belgio', 'Belize', 'Bielorussia', 'Birmania', 'Bolivia',
    'Bosnia ed Erzegovina', 'Botswana', 'Brasile', 'Bulgaria', 'Burkina Faso',
    'Burundi', 'Cambogia', 'Camerun', 'Canada', 'Capo Verde', 'Ciad', 'Cile',
    'Cina', 'Cipro', 'Colombia', 'Corea del Nord', 'Corea del Sud', 'Costa d\'Avorio',
    'Costa Rica', 'Croazia', 'Cuba', 'Danimarca', 'Ecuador', 'Egitto', 'Emirati Arabi Uniti',
    'Eritrea', 'Estonia', 'Etiopia', 'Filippine', 'Finlandia', 'Francia', 'Gabon',
    'Gambia', 'Georgia', 'Germania', 'Ghana', 'Giappone', 'Gibuti', 'Giordania',
    'Grecia', 'Guatemala', 'Guinea', 'Guinea-Bissau', 'Guinea Equatoriale', 'Haiti',
    'Honduras', 'India', 'Indonesia', 'Iran', 'Iraq', 'Irlanda', 'Islanda',
    'Israele', 'Italia', 'Kazakistan', 'Kenya', 'Kirghizistan', 'Kosovo', 'Kuwait',
    'Laos', 'Lettonia', 'Libano', 'Liberia', 'Libia', 'Liechtenstein', 'Lituania',
    'Lussemburgo', 'Macedonia del Nord', 'Madagascar', 'Malawi', 'Malesia', 'Maldive',
    'Mali', 'Malta', 'Marocco', 'Mauritania', 'Mauritius', 'Messico', 'Moldavia',
    'Mongolia', 'Montenegro', 'Mozambico', 'Namibia', 'Nepal', 'Nicaragua', 'Niger',
    'Nigeria', 'Norvegia', 'Nuova Zelanda', 'Oman', 'Paesi Bassi', 'Pakistan',
    'Palestina', 'Panama', 'Papua Nuova Guinea', 'Paraguay', 'Perù', 'Polonia',
    'Portogallo', 'Qatar', 'Regno Unito', 'Repubblica Ceca', 'Repubblica Democratica del Congo',
    'Repubblica del Congo', 'Romania', 'Russia', 'Ruanda', 'Senegal', 'Serbia',
    'Sierra Leone', 'Singapore', 'Siria', 'Slovacchia', 'Slovenia', 'Somalia',
    'Spagna', 'Sri Lanka', 'Stati Uniti', 'Sudafrica', 'Sudan', 'Sudan del Sud',
    'Svezia', 'Svizzera', 'Swaziland', 'Tagikistan', 'Taiwan', 'Tanzania',
    'Thailandia', 'Timor Est', 'Togo', 'Trinidad e Tobago', 'Tunisia', 'Turchia',
    'Turkmenistan', 'Ucraina', 'Uganda', 'Ungheria', 'Uruguay', 'Uzbekistan',
    'Venezuela', 'Vietnam', 'Yemen', 'Zambia', 'Zimbabwe'
];

var variantsToCanonical = {
    'USA': 'Stati Uniti', 'U.S.A.': 'Stati Uniti', 'U.S.A': 'Stati Uniti',
    'United States': 'Stati Uniti', 'United States of America': 'Stati Uniti',
    'Stati Uniti d\'America': 'Stati Uniti',
    'US': 'Stati Uniti', 'U.S.': 'Stati Uniti', 'America': 'Stati Uniti',
    'UK': 'Regno Unito', 'U.K.': 'Regno Unito', 'United Kingdom': 'Regno Unito',
    'Gran Bretagna': 'Regno Unito', 'Britain': 'Regno Unito', 'Inghilterra': 'Regno Unito',
    'Russia': 'Russia', 'Federazione Russa': 'Russia', 'Russian Federation': 'Russia',
    'Ucraina': 'Ucraina', 'Ukraine': 'Ucraina',
    'Cina': 'Cina', 'China': 'Cina', 'PRC': 'Cina', 'RPC': 'Cina',
    'Corea del Nord': 'Corea del Nord', 'North Korea': 'Corea del Nord', 'DPRK': 'Corea del Nord',
    'Corea del Sud': 'Corea del Sud', 'South Korea': 'Corea del Sud',
    'Iran': 'Iran', 'Iraq': 'Iraq', 'Siria': 'Siria', 'Syria': 'Siria',
    'Israele': 'Israele', 'Israel': 'Israele',
    'Palestina': 'Palestina', 'Palestine': 'Palestina', 'Territori palestinesi': 'Palestina',
    'Emirati Arabi Uniti': 'Emirati Arabi Uniti', 'UAE': 'Emirati Arabi Uniti', 'EAU': 'Emirati Arabi Uniti',
    'Arabia Saudita': 'Arabia Saudita', 'Saudi Arabia': 'Arabia Saudita',
    'Turchia': 'Turchia', 'Turkey': 'Turchia',
    'Egitto': 'Egitto', 'Egypt': 'Egitto',
    'Libia': 'Libia', 'Libya': 'Libia',
    'Germania': 'Germania', 'Germany': 'Germania',
    'Francia': 'Francia', 'France': 'Francia',
    'Italia': 'Italia', 'Italy': 'Italia', 'IT': 'Italia',
    'Spagna': 'Spagna', 'Spain': 'Spagna',
    'Paesi Bassi': 'Paesi Bassi', 'Netherlands': 'Paesi Bassi', 'Olanda': 'Paesi Bassi', 'Holland': 'Paesi Bassi',
    'Belgio': 'Belgio', 'Belgium': 'Belgio',
    'Svizzera': 'Svizzera', 'Switzerland': 'Svizzera',
    'Austria': 'Austria',
    'Polonia': 'Polonia', 'Poland': 'Polonia',
    'Ucraina': 'Ucraina', 'Ukraine': 'Ucraina',
    'Bielorussia': 'Bielorussia', 'Belarus': 'Bielorussia',
    'Moldavia': 'Moldavia', 'Moldova': 'Moldavia',
    'Romania': 'Romania',
    'Ungheria': 'Ungheria', 'Hungary': 'Ungheria',
    'Repubblica Ceca': 'Repubblica Ceca', 'Czech Republic': 'Repubblica Ceca', 'Cechia': 'Repubblica Ceca',
    'Slovacchia': 'Slovacchia', 'Slovakia': 'Slovacchia',
    'Grecia': 'Grecia', 'Greece': 'Grecia',
    'Vietnam': 'Vietnam', 'Viet Nam': 'Vietnam',
    'India': 'India', 'Indonesia': 'Indonesia', 'Pakistan': 'Pakistan', 'Bangladesh': 'Bangladesh',
    'Afghanistan': 'Afghanistan', 'Giappone': 'Giappone', 'Japan': 'Giappone',
    'Australia': 'Australia', 'Nuova Zelanda': 'Nuova Zelanda', 'New Zealand': 'Nuova Zelanda',
    'Canada': 'Canada', 'Messico': 'Messico', 'Mexico': 'Messico',
    'Brasile': 'Brasile', 'Brazil': 'Brasile',
    'Argentina': 'Argentina', 'Cile': 'Cile', 'Chile': 'Cile',
    'Colombia': 'Colombia', 'Perù': 'Perù', 'Peru': 'Perù',
    'Venezuela': 'Venezuela', 'Sudafrica': 'Sudafrica', 'South Africa': 'Sudafrica',
    'Nigeria': 'Nigeria', 'Kenya': 'Kenya', 'Etiopia': 'Etiopia', 'Ethiopia': 'Etiopia',
    'RD Congo': 'Repubblica Democratica del Congo', 'Congo (RDC)': 'Repubblica Democratica del Congo',
    'Congo': 'Repubblica del Congo', 'Rep. Congo': 'Repubblica del Congo',
    'Macedonia': 'Macedonia del Nord', 'North Macedonia': 'Macedonia del Nord',
    'Taiwan': 'Taiwan', 'Formosa': 'Taiwan',
    'Kosovo': 'Kosovo', 'Serbia': 'Serbia', 'Bosnia': 'Bosnia ed Erzegovina',
    'Eswatini': 'Swaziland', 'eSwatini': 'Swaziland'
};

function escapeRegex(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeKey(s) {
    return String(s || '')
        .trim()
        .replace(/\s+/g, ' ')
        .replace(/[.,;:!?]+$/, '')
        .toLowerCase();
}

/**
 * Sostituisce nel testo tutte le varianti con il nome canonico della nazione.
 * Ordine: varianti più lunghe prima per evitare sostituzioni parziali.
 */
function normalizeCountryNamesInText(text) {
    if (typeof text !== 'string') return text;
    var result = text;
    var entries = [];
    var k;
    for (k in variantsToCanonical) {
        if (variantsToCanonical.hasOwnProperty(k)) entries.push({ variant: k, canonical: variantsToCanonical[k] });
    }
    entries.sort(function (a, b) { return b.variant.length - a.variant.length; });
    for (var i = 0; i < entries.length; i++) {
        var variant = entries[i].variant;
        var canonical = entries[i].canonical;
        if (variant === canonical) continue;
        // Confine di parola per evitare sostituzioni in mezzo (es. "IT" in "GitHub" -> "GItaliaHub")
        var re = new RegExp('\\b' + escapeRegex(variant) + '\\b', 'gi');
        result = result.replace(re, canonical);
    }
    return result;
}

// Mappa nome canonico (italiano) -> codice ISO 3166-1 alpha-2 per jsVectorMap world
var nationToIsoCode = {
    'Afghanistan': 'af', 'Albania': 'al', 'Algeria': 'dz', 'Andorra': 'ad', 'Angola': 'ao',
    'Arabia Saudita': 'sa', 'Argentina': 'ar', 'Armenia': 'am', 'Australia': 'au', 'Austria': 'at',
    'Azerbaigian': 'az', 'Bahrein': 'bh', 'Bangladesh': 'bd', 'Belgio': 'be', 'Belize': 'bz',
    'Bielorussia': 'by', 'Birmania': 'mm', 'Bolivia': 'bo', 'Bosnia ed Erzegovina': 'ba',
    'Botswana': 'bw', 'Brasile': 'br', 'Bulgaria': 'bg', 'Burkina Faso': 'bf', 'Burundi': 'bi',
    'Cambogia': 'kh', 'Camerun': 'cm', 'Canada': 'ca', 'Capo Verde': 'cv', 'Ciad': 'td',
    'Cile': 'cl', 'Cina': 'cn', 'Cipro': 'cy', 'Colombia': 'co', 'Corea del Nord': 'kp',
    'Corea del Sud': 'kr', 'Costa d\'Avorio': 'ci', 'Costa Rica': 'cr', 'Croazia': 'hr',
    'Cuba': 'cu', 'Danimarca': 'dk', 'Ecuador': 'ec', 'Egitto': 'eg', 'Emirati Arabi Uniti': 'ae',
    'Eritrea': 'er', 'Estonia': 'ee', 'Etiopia': 'et', 'Filippine': 'ph', 'Finlandia': 'fi',
    'Francia': 'fr', 'Gabon': 'ga', 'Gambia': 'gm', 'Georgia': 'ge', 'Germania': 'de',
    'Ghana': 'gh', 'Giappone': 'jp', 'Gibuti': 'dj', 'Giordania': 'jo', 'Grecia': 'gr',
    'Guatemala': 'gt', 'Guinea': 'gn', 'Guinea-Bissau': 'gw', 'Guinea Equatoriale': 'gq',
    'Haiti': 'ht', 'Honduras': 'hn', 'India': 'in', 'Indonesia': 'id', 'Iran': 'ir',
    'Iraq': 'iq', 'Irlanda': 'ie', 'Islanda': 'is', 'Israele': 'il', 'Italia': 'it',
    'Kazakistan': 'kz', 'Kenya': 'ke', 'Kirghizistan': 'kg', 'Kosovo': 'xk', 'Kuwait': 'kw',
    'Laos': 'la', 'Lettonia': 'lv', 'Libano': 'lb', 'Liberia': 'lr', 'Libia': 'ly',
    'Liechtenstein': 'li', 'Lituania': 'lt', 'Lussemburgo': 'lu', 'Macedonia del Nord': 'mk',
    'Madagascar': 'mg', 'Malawi': 'mw', 'Malesia': 'my', 'Maldive': 'mv', 'Mali': 'ml',
    'Malta': 'mt', 'Marocco': 'ma', 'Mauritania': 'mr', 'Mauritius': 'mu', 'Messico': 'mx',
    'Moldavia': 'md', 'Mongolia': 'mn', 'Montenegro': 'me', 'Mozambico': 'mz', 'Namibia': 'na',
    'Nepal': 'np', 'Nicaragua': 'ni', 'Niger': 'ne', 'Nigeria': 'ng', 'Norvegia': 'no',
    'Nuova Zelanda': 'nz', 'Oman': 'om', 'Paesi Bassi': 'nl', 'Pakistan': 'pk',
    'Palestina': 'ps', 'Panama': 'pa', 'Papua Nuova Guinea': 'pg', 'Paraguay': 'py',
    'Perù': 'pe', 'Polonia': 'pl', 'Portogallo': 'pt', 'Qatar': 'qa',
    'Regno Unito': 'gb', 'Repubblica Ceca': 'cz', 'Repubblica Democratica del Congo': 'cd',
    'Repubblica del Congo': 'cg', 'Romania': 'ro', 'Russia': 'ru', 'Ruanda': 'rw',
    'Senegal': 'sn', 'Serbia': 'rs', 'Sierra Leone': 'sl', 'Singapore': 'sg', 'Siria': 'sy',
    'Slovacchia': 'sk', 'Slovenia': 'si', 'Somalia': 'so', 'Spagna': 'es', 'Sri Lanka': 'lk',
    'Stati Uniti': 'us', 'Sudafrica': 'za', 'Sudan': 'sd', 'Sudan del Sud': 'ss',
    'Svezia': 'se', 'Svizzera': 'ch', 'Swaziland': 'sz', 'Tagikistan': 'tj', 'Taiwan': 'tw',
    'Tanzania': 'tz', 'Thailandia': 'th', 'Timor Est': 'tl', 'Togo': 'tg',
    'Trinidad e Tobago': 'tt', 'Tunisia': 'tn', 'Turchia': 'tr', 'Turkmenistan': 'tm',
    'Ucraina': 'ua', 'Uganda': 'ug', 'Ungheria': 'hu', 'Uruguay': 'uy', 'Uzbekistan': 'uz',
    'Venezuela': 've', 'Vietnam': 'vn', 'Yemen': 'ye', 'Zambia': 'zm', 'Zimbabwe': 'zw'
};

function getNationIsoCode(nationName) {
    if (!nationName || typeof nationName !== 'string') return null;
    var canonical = getCanonicalNameIfValid(nationName);
    return canonical ? (nationToIsoCode[canonical] || null) : null;
}

/**
 * Restituisce il nome canonico della nazione se è nell'elenco canonical o riconducibile tramite variantsToCanonical; altrimenti null.
 * Usato per filtrare le nazioni restituite dall'IA prima di scrivere in articolielaborati.json.
 */
function getCanonicalNameIfValid(name) {
    if (!name || typeof name !== 'string') return null;
    var n = String(name).trim();
    if (!n) return null;
    var c = variantsToCanonical[n] || n;
    if (canonical.indexOf(c) !== -1) return c;

    // Fallback case-insensitive su canonical + varianti (utile per output IA: "iran", "RUSSIA", ecc.)
    var nk = normalizeKey(n);
    for (var i = 0; i < canonical.length; i++) {
        if (normalizeKey(canonical[i]) === nk) return canonical[i];
    }
    for (var k in variantsToCanonical) {
        if (!variantsToCanonical.hasOwnProperty(k)) continue;
        if (normalizeKey(k) === nk) {
            var mapped = variantsToCanonical[k];
            if (canonical.indexOf(mapped) !== -1) return mapped;
        }
    }
    return null;
}

module.exports = {
    canonical: canonical,
    variantsToCanonical: variantsToCanonical,
    nationToIsoCode: nationToIsoCode,
    normalizeCountryNamesInText: normalizeCountryNamesInText,
    getNationIsoCode: getNationIsoCode,
    getCanonicalNameIfValid: getCanonicalNameIfValid
};
