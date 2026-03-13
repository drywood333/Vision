// Data odierna in formato "26 febbraio 2026", usata nei prompt
const DATAOGGI = (() => {
    const now = new Date();
    const day = now.getDate();
    const year = now.getFullYear();
    const mesi = [
        'gennaio', 'febbraio', 'marzo', 'aprile',
        'maggio', 'giugno', 'luglio', 'agosto',
        'settembre', 'ottobre', 'novembre', 'dicembre'
    ];
    const monthName = mesi[now.getMonth()] || '';
    return `${day} ${monthName} ${year}`;
})();

// Valore di certezza globale (0-100) usabile nei prompt, es. per precompilare la "Percentuale di certezza"
// Puoi modificare facilmente questa costante per influenzare tutti i prompt che la usano.
const CERTEZZA = 68;

// Valore globale "giorni" usabile nei prompt (es. come default per il campo "Giorni")
// Modifica questo numero per cambiare rapidamente il riferimento in tutti i prompt che lo usano.
const GIORNI = 7;
const GIORNI_NOTE = 15;

// Stringhe riutilizzabili nei prompt (definite prima per evitare riferimenti circolari)
const CONTESTO_ATTUALE = `
Contesto attuale da tenere presente ad oggi ${DATAOGGI}:

Tensioni Russia-Ucraina in corso
Conflitto Israele-Palestina/Hamas
Tensioni USA-Cina su Taiwan
Instabilità in Medio Oriente (Iran, Yemen, Siria)
Rivalità USA-Russia-Cina in Africa e Artico
Tensioni India-Pakistan/Cina
Guerra ibrida e cyberwarfare diffusa
Fluttuazioni economiche globali (inflazione, crisi energetiche, instabilità finanziaria)
Tieni in considerazione anche le notizie attuali e fluttuazioni economiche che possano essere indicative.
`;

const PARAMETRI_NAZIONE = `
PARAMETRI DISPONIBILI (valori da 0 a 100):

importanza_di_questo_articolo
tensione_geopolitica
attivita_militare
attivita_militare_osservata
rischio_incidente
rischio_escalation
attivita_diplomatica_offensiva
pressione_internazionale
stato_mediazione_diplomatica
sostegno_alleati
imprevedibilita_leadership
livello_deterrenza
coesione_decisionale
capacita_militare_attuale
livello_modernizzazione_forze_armate
preparazione_operativa
esperienza_combattimento_recente
capacita_proiezione_forza
capacita_difesa_territoriale
capabilita_risposta_missilistica
capacita_nucleare
capacita_logistica
capacita_industria_bellica
stato_morale_forzearmate
capacita_guerra_ibrida
capacita_offensiva_cibernetica
capacita_difesa_cibernetica
capacita_spaziale
capacita_intelligence
pressione_economica
capacita_economica_sostenere_guerra
autonomia_energetica
dipendenza_esterna_critica
risorse_strategiche
stabilita_interna
polarizzazione_politica
mobilitazione_popolare
vulnerabilita_interna
posizione_geografica_strategica
controllo_territoriale_effettivo
andamento_oro
riserve_valutarie
export_energetico
spesa_militare_annunciata
coscrizione_obbligatoria
test_missilistici
attacchi_ibridi_subiti
flussi_migratori
espulsioni_diplomatiche
narrativa_nemico
disinformazione_rilevata
visite_ufficiali
lotte_fazioni_potere
ritiro_trattati_internazionali
retorica_bellicosa
rischio_incidente_nucleare
`;

const REGOLE_TECNICHE = `
REGOLE TECNICHE:
NON includere markdown (json)
NON aggiungere testo esplicativo prima o dopo il JSON
NON includere pensieri, commenti o ragionamenti
Restituisci ESCLUSIVAMENTE l'array JSON richiesto
La risposta deve iniziare con [ e finire con ]
`;

const REGOLE_FOCUS = `
REGOLE SUL FOCUS DA MANTENERE NELL'ANALISI:
Importante: L'obiettivo è sempre una analisi in vista di un conflitto mondiale
Individuare e valutare solo elementi che potrebbero contribuire a un conflitto militare globale, 
trascurando dinamiche relative a guerre locali, conflitti limitati o tensioni regionali non escalabili a livello mondiale.

Metodo di analisi adottato:
1. Fattori chiave monitorati:
   - Attivazione di alleanze militari multilaterali (es. articoli NATO vs. CSTO).
   - Movimenti strategici di truppe/mezzi su scala transcontinentale.
   - Dichiarazioni di stati maggiori o leader di potenze nucleari che minacciano l'uso diretto della forza contro altre grandi potenze.
   - Sanzioni economiche o azioni diplomatiche con chiara implicazione di "casus belli" globale.
   - Crisi in aree geopolitiche critiche (es. stretto di Taiwan, confine NATO-Russia, penisola coreana) se coinvolgono direttamente più grandi potenze in contrapposizione.

2. Elementi esclusi automaticamente:
   - Conflitti intraregionali (es. guerre civili, scontri confinari tra piccoli stati).
   - Attacchi terroristici o operazioni militari limitate a un solo teatro.
   - Tensioni diplomatiche non supportate da mobilitazioni militari su larga scala.

`;

const REGOLE_GG_GR = `
Il tuo compito è:
Per ogni nazione presente, analizzare i parametri e stimare due valori:

1. **GG (Giorni all'entrata in Guerra Mondiale)** : numero più certo di giorni prima che la nazione possa effettivamente lanciare un attacco in Guerra Mondiale su scala significativa. Considera non solo la capacità tecnica, ma anche l'intenzione, la tensione attuale, la prontezza operativa e i vincoli interni/esterni. 

2. **GR (Giorni a lancio nucleare)** : numero più certo di giorni prima che la nazione possa lanciare il primo missile a testata nucleare in uno scenario di escalation mondiale. Basato su capacità nucleari, dottrina, livello di deterrenza, rischio di escalation e prontezza. Per nazioni non nucleari o con capacità irrilevante, GR deve essere null.

Linee guida per la stima (da usare come ponderazione, non rigidamente):

GG (Giorni al Conflitto Mondiale): Numero di giorni a partire da oggi (${DATAOGGI}) entro i quali è praticamente certo che la nazione inneschi o entri ufficialmente in un conflitto Mondiale su scala significativa. Considera: escalation in corso, movimenti di truppe previsti, scadenze politiche (es. elezioni, anniversari), crisi economiche che spingono alla guerra, e finestre stagionali favorevoli alle operazioni militari.
Per GG :
- Parametri chiave (peso maggiore):
  - tensione_geopolitica: indica l'intenzione/immediatezza
  - attivita_militare: livello attuale di attività bellica
  - rischio_escalation: probabilità che la tensione degeneri
  - capacita_militare_attuale: capacità complessiva di condurre guerra
  - preparazione_operativa: prontezza delle forze
- Parametri secondari (modulano la stima):
  - retorica_bellicosa, narrativa_nemico, imprevedibilita_leadership
  - mobilitazione_popolare, coscrizione_obbligatoria
  - pressione_economica (se altissima, può accelerare o ritardare)

GR (Giorni al Nucleare): Numero di giorni a partire da oggi (${DATAOGGI}) entro i quali è praticamente certo un primo utilizzo di armi nucleari. Considera: capacità nucleare, dottrina di deterrenza, test missilistici in programma, anniversari storici di tensioni, e imprevedibilità della leadership.
Per GR :
- Parametri abilitanti (condizioni necessarie):
  - Possesso di missili balistici/capacità di consegna (deducibile da parametri come capacita_risposta_missilistica, test_missilistici)
- Parametri di propensione (peso maggiore):
  - livello_deterrenza: quanto la dottrina nucleare è parte della strategia
  - rischio_escalation: contesto di crisi che potrebbe portare all'uso
  - imprevedibilita_leadership: fattore umano di rischio
  - tensione_geopolitica: pressione esterna che potrebbe innescare
- Parametri di capacità operativa:
  - preparazione_operativa (delle forze nucleari)
  - test_missilistici (frequenza e successo)
  - capacita_risposta_missilistica

IMPORTANTE:
Se GR = 0 e GG > 0 allora GR = null.
Se GR risulta inferiore a GG ma GR non è null, porta GR a GG. 
Per tutte le potenze nucleari, dopo il calcolo, assicura che GG ≥ GR (il nucleare non viene prima della guerra convenzionale).
`;

const config = {
    TipoIA: parseInt(process.env.TIPO_IA, 10) || 3,
    ai_cursor_key: process.env.CURSOR_AI_KEY || 'key_f8af48988f468a8cf25d13c7acc39a5b12328df09e659e5b7c869aa783e1cfe4',
    ai_cursor_use_cloud_agents: true,
    ai_cursor_agent_repo: process.env.CURSOR_AGENT_REPO || 'https://github.com/drywood333/Vision.git',
    ai_cursor_agent_ref: process.env.CURSOR_AGENT_REF || 'main',
    ai_cursor_model: process.env.CURSOR_AI_MODEL || 'composer-1.5',
    ai_api_url: process.env.GPT4ALL_URL || 'http://127.0.0.1:4891/v1/chat/completions',
    ai_model: 'Llama 3 8B Instruct', 
    ai_api_key: '',
    ai_use_dummy_auth: false,
    ai_delay_between_requests_ms: 5000,
    // Timeout massimo base per una singola chiamata IA (DeepSeek / GPT4All), in millisecondi.
    // Se la risposta non arriva in tempo, la richiesta viene chiusa con errore e la pipeline prosegue.
    ai_timeout_ms: 300000,
    // Timeout dedicato per question_per_article (prompt lunghi/articoli complessi).
    ai_timeout_ms_question_article: 300000,
    ai_retry_on_401: true,
    ai_retry_delay_ms: 8000,
    ai_max_retries: 5,
    ai_deepseek_key: process.env.DEEPSEEK_API_KEY || 'sk-b175988e356745e28abf78228b730bef',
    ai_deepseek_url: process.env.DEEPSEEK_API_URL || 'https://api.deepseek.com/v1/chat/completions',
    // Modello DeepSeek di default (chat generalista)
    ai_deepseek_model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
    // Modello DeepSeek "reasoner" (per question_ che richiedono più ragionamento)
    ai_deepseek_model_reasoner: process.env.DEEPSEEK_MODEL_REASONER || 'deepseek-reasoner',
    // Mappa opzionale: per ogni stage (es. question_per_article, question_note, ecc.) puoi specificare un modello diverso
    // Se non impostato, verrà usato ai_deepseek_model_reasoner (se definito) o ai_deepseek_model.
    ai_deepseek_models_by_stage: {
        // Esempi (puoi personalizzarli):
        question_per_article: 'deepseek-reasoner',
        question_EMWA_Pesato_Sommato: 'deepseek-chat',
        question_EMWA_Pesato_Sommato_IA: 'deepseek-chat',
        question_note: 'deepseek-reasoner',
        question_RED: 'deepseek-reasoner',
        scraping_telegram: 'deepseek-chat',
        question_pertinente: 'deepseek-chat',
        ai_chat: 'deepseek-chat'
    },
    // Lunghezza massima risposta API (token). Aumentare se le risposte risultano troncate.
    ai_deepseek_max_tokens: 8000,
    ai_deepseek_max_tokens_question_article: 5000,
    ai_deepseek_max_tokens_scraping_telegram: 2800,
    ai_deepseek_max_tokens_scraping_telegram_retry: 2200,
    ai_deepseek_max_tokens_scraping_youtube: 2000,
    ai_deepseek_max_tokens_question_pertinente: 4000,
    ai_deepseek_max_tokens_ai_chat: 4000,
    ai_deepseek_max_tokens_question_emwa: 8000,
    ai_deepseek_max_tokens_question_v5: 8000,
    ai_deepseek_max_tokens_question_red: 8000,
    // Soglie minime GG per paese (default per i non presenti: 3650 giorni)
    soglie_gg_minime: {
        // Paesi in guerra o crisi imminente
        'Ucraina': 1,
        'Russia': 5,
        'Israele': 15,
        'Iran': 15,
        'Corea del Nord': 15,
        // Potenze con coinvolgimenti possibili
        'Stati Uniti': 15,
        'Cina': 30,
        'India': 30,
        'Pakistan': 30,
        'Francia': 15,
        'Regno Unito': 15,
        // Nuclear sharing (coinvolgimento indiretto possibile)
        'Italia': 30,
        'Germania': 30,
        'Turchia': 30,
        'Bielorussia': 30
    },
    // Dottrine nucleari per vincoli GR/GG (default non presente: min_ratio=1.0, forza_null=true)
    dottrine_nucleari: {
        // Potenze nucleari ufficiali
        'Cina': { min_ratio: 2.0, forza_null: false },
        'Francia': { min_ratio: 1.2, forza_null: false },
        'Russia': { min_ratio: 1.5, forza_null: false },
        'Stati Uniti': { min_ratio: 1.2, forza_null: false },
        'Regno Unito': { min_ratio: 1.2, forza_null: false },
        // Potenze extra-NPT
        'India': { min_ratio: 1.8, forza_null: false },
        'Israele': { min_ratio: 1.5, forza_null: false },
        'Corea del Nord': { min_ratio: 1.0, forza_null: false },
        'Pakistan': { min_ratio: 1.0, forza_null: false },
        // Nuclear sharing NATO (USA)
        'Italia': { min_ratio: 2.5, forza_null: false },
        'Germania': { min_ratio: 2.5, forza_null: false },
        'Belgio': { min_ratio: 2.5, forza_null: false },
        'Paesi Bassi': { min_ratio: 2.5, forza_null: false },
        'Turchia': { min_ratio: 2.5, forza_null: false },
        // Nuclear sharing Russia
        'Bielorussia': { min_ratio: 2.5, forza_null: false }
    },
    // Paesi la cui dottrina NON prevede first-strike nucleare
    // (usati per vincolare GR >= GG*2 nella sintesi V4)
    dottrine_no_first_strike: [
        'Cina',
        'India'
    ],
    facebook_cookie: process.env.FACEBOOK_COOKIE || 'sb=-Iw-YL4OfGB9MdgNszgJu3Vk; datr=UUsWaetRpt8vyw1Y0d5rkLda; oo=v1; c_user=100001495741078; i_user=100057168471028; fr=0cdlqmQ3nI59lg4wX.AWfcfqnUcoi4rvx2ggyza7xrrw0FNtSBMzviIr18H6j8Bwqze_E.BpihLh..AAA.0.0.BpihPP.AWeHMtqD85PtMW3xVyU9w3NLQ9s; xs=30%3A66FlnAthQgRF9g%3A2%3A1770656482%3A-1%3A-1%3A%3AAczQ86dRU3rRqpWRZ-Jyyn6KeUOJwa0xHYyGoIy8mA; wd=895x1243',

    prompts: {
        contesto_attuale: CONTESTO_ATTUALE,
        parametri_nazione: PARAMETRI_NAZIONE,
        regole_tecniche: REGOLE_TECNICHE,

        question_pertinente: `
Sei un analista geopolitico senior specializzato in conflitti internazionali e crisi belliche.

Il tuo compito è valutare se un articolo di cronaca è PERTINENTE o NON PERTINENTE ai fini di un'analisi sulle dinamiche che potrebbero condurre a un conflitto militare globale.

Contesto geopolitico attuale (${DATAOGGI}):
Considera come sfondo le tensioni in corso in: Ucraina, Medio Oriente (Israele-Palestina, Iran, Yemen, Siria), Stretto di Taiwan, rivalità tra grandi potenze (USA-Cina-Russia) in Africa e Artico, e le tensioni India-Pakistan/Cina. Includi nell'analisi l'impatto della guerra ibrida, cyberwarfare e le fluttuazioni economiche globali (inflazione, crisi energetiche) come fattori di stress sistemico.

Criteri di Pertinenza (INCLUSIONE)
Un articolo è PERTINENTE se il suo tema principale riguarda ALMENO UNO dei seguenti aspetti, con un potenziale chiaro di influenzare equilibri globali:

Azioni militari e di difesa: Operazioni belliche, mobilitazioni di truppe su larga scala, attivazione di alleanze militari (es. NATO, CSTO), dispiegamento di armi strategiche, esercitazioni congiunte di grandi potenze.

Geopolitica delle risorse e dell'economia: Competizione per risorse strategiche (chip, litio, terre rare, energia); uso di strumenti economici coercitivi (sanzioni, embarghi) in contesti di conflitto; fluttuazioni critiche dell'oro o di altre materie prime che indichino instabilità.

Tecnologia e guerra ibrida: Guerra tecnologica per l'egemonia digitale (es. attacchi a infrastrutture critiche, cavi sottomarini); dipendenza tecnologica come strumento di potere; uso della geoingegneria come arma.

Retorica e diplomazia bellicosa: Dichiarazioni pubbliche di leader di grandi potenze che contengono minacce dirette di uso della forza, retorica di guerra, o che ridefiniscono aggressivamente alleanze.

Scenari post-conflitto: Piani di ricostruzione, stabilizzazione o smilitarizzazione che ridisegnano le sfere di influenza e le future alleanze strategiche.

Indizi di escalation: Qualsiasi evento in aree critiche (Stretto di Hormuz, Mar Cinese Meridionale, confine NATO-Russia) che veda contrapposte direttamente grandi potenze e possa fungere da innesco.

Regole di Esclusione (RIGOROSE)

Tema dominante: Se il tema principale dell'articolo NON rientra nei criteri di cui sopra, restituisci ESCLUSIVAMENTE la stringa: "NON PERTINENTE".

Falsi positivi: La mera menzione di una nazione o di una guerra non è sufficiente. Escludi automaticamente articoli di cronaca locale, interna, religiosa, culturale, sportiva o vicende prive di collegamento diretto con le dinamiche di potere internazionali e il rischio di escalation globale. In caso di dubbio, prevale l'esclusione.

Focus dell'Analisi
L'obiettivo è sempre valutare il potenziale contributo dell'evento a un conflitto mondiale. Distingui tra conflitti locali/regionali e situazioni in cui sono coinvolte direttamente grandi potenze in contrapposizione, con il rischio concreto di un'allargamento del conflitto.

Formato di Output
La risposta deve essere UN SOLO array JSON valido, contenente un oggetto con i seguenti campi:

"stato": "PERTINENTE" o "NON PERTINENTE".

"nota": Una breve spiegazione (max due frasi) della decisione, basata sui criteri sopra.

"notizia": Riassunto dell'articolo, riportando in dettaglio la notizia principale.  

"autore": L'autore dell'articolo, se specificato; altrimenti "Non specificato".

Esempio:
[{"stato": "PERTINENTE", "nota": "L'articolo descrive un attacco a un alleato USA da parte dell'Iran in uno stretto strategico, aumentando il rischio di confronto diretto tra le due potenze.", "notizia": "Un drone attribuito all'Iran ha colpito una nave cargo militare israeliana nel Golfo di Oman.", "autore": "Mario Rossi"}]


${REGOLE_TECNICHE}

Ecco l'articolo:

`,

    scraping_Blog: `
Sei un assistente di scraping.
Ti viene fornito il testo di una pagina Web in HTML .
Da questo testo, estrai i link agli articoli presenti nella sezione principale della pagina.
Prediligi la sezione che riporta una lista di articoli come elemnto principale.

Restituisci SOLO un array JSON con oggetti nel formato:
[
  {"Titolo":"...", "Data":"YYYY-MM-DD", "linkarticolo":"https://..."}
]

${REGOLE_TECNICHE}
includi solo link di articoli con testo significativo
"Data" deve essere in formato YYYY-MM-DD 
se nel testo del post trovi una riga "datetime: ...", usala come fonte prioritaria per "Data"
se manca il datetime esplicito, prova a dedurre la data dal contesto testuale del blocco articolo.
"linkarticolo" contiene il link all'articolo vero e proprio.


`,

        scraping_Telegram: `
Sei un assistente di scraping.
Ti viene fornito il testo di una pagina Telegram già estratto e ripulito da HTML (mantenendo eventuali datetime).
Da questo testo, estrai un massimo di 20 post.

Restituisci SOLO un array JSON con oggetti nel formato:
[
  {"testo":"...", "Data":"YYYY-MM-DD", "linkvideo":"https://... oppure stringa vuota"}
]

${REGOLE_TECNICHE}
includi solo post con testo significativo
"Data" deve essere in formato YYYY-MM-DD 
se nel testo del post trovi una riga "datetime: ...", usala come fonte prioritaria per "Data"
se manca il datetime esplicito, prova a dedurre la data dal contesto testuale del blocco post
"linkvideo" contiene il link video del post se presente, altrimenti stringa vuota

ISTRUZIONI PER IDENTIFICARE I POST:
tratta ogni blocco di testo come potenziale post separato
ignora blocchi vuoti o puramente navigazionali ("Fonte", "Telegram | X | Web |...", ecc.)
mantieni il testo del post il più fedele possibile all'input (pulito)

`,

        scraping_Youtube: `
Sei un assistente di scraping.
Dato un URL YouTube (canale, pagina /videos o playlist), estrai gli ultimi 50 link dei video presenti.

Restituisci SOLO un array JSON nel formato:
[
  {"linkvideo":"https://www.youtube.com/watch?v=...", "title":"titolo video opzionale"}
]

${REGOLE_TECNICHE}
includi solo link video YouTube validi
non includere shorts non YouTube o link esterni non video
non includere testo extra fuori dal JSON
se il titolo non è disponibile, usa stringa vuota

URL YouTube:
`,

        // Domanda fatta all'AI per ogni articolo (usata se in UI non ne inserisci una)
        question_per_article: `
Sei un analista geopolitico senior specializzato in conflitti internazionali e crisi belliche.

1. OBIETTIVO E FOCUS DELL'ANALISI
Il tuo compito è analizzare articoli di cronaca per valutare il loro potenziale contributo a un conflitto militare globale. L'obiettivo è sempre e solo questo: individuare elementi che potrebbero escalare da tensioni locali/regionali a uno scontro diretto tra grandi potenze.

Focus esclusivo: dinamiche con chiara implicazione globale.
Da trascurare: guerre civili, conflitti intraregionali non escalabili, attacchi terroristici limitati a un solo teatro, tensioni diplomatiche non supportate da mobilitazioni militari su larga scala.

2. CONTESTO GEOPOLITICO DI RIFERIMENTO (${DATAOGGI})
Tieni presenti queste tensioni come sfondo dell'analisi:

Russia-Ucraina in corso

Israele-Palestina/Hamas

USA-Cina su Taiwan

Instabilità in Medio Oriente (Iran, Yemen, Siria)

Rivalità USA-Russia-Cina in Africa e Artico

Tensioni India-Pakistan/Cina

Guerra ibrida e cyberwarfare diffusa

Fluttuazioni economiche globali (inflazione, crisi energetiche, instabilità finanziaria)

3. PRINCIPI FONDAMENTALI DELL'ANALISI
Solo nazioni esplicitamente nominate: Non aggiungere nazioni implicite o inferite.

Regola di centralità: Considera solo le nazioni che sono parte centrale del discorso dell'articolo. Se una nazione appare solo in un contesto marginale (es. un paragrafo secondario), non includerla.

Trattamento delle sezioni: Se l'articolo è composto da più notizie indipendenti, analizza solo la prima notizia principale.

Pertinenza dei parametri: Per ogni nazione inclusa, utilizza esclusivamente i parametri che puoi ragionevolmente dedurre dalle informazioni presenti nell'articolo. Puoi integrare con la tua conoscenza del contesto geopolitico fornito (sezione 2) per calibrare i parametri, specialmente quelli relativi a capacità militari note (es. nucleare) o a tensioni storiche.

Se non trovi elementi importanti per una nazione citata, ignorala (non inserirla nel JSON).

4. CRITERI DI PERTINENZA (Cosa rende un evento escalabile a livello globale)
Un articolo merita un'analisi approfondita se contiene almeno uno di questi fattori chiave:

Attivazione di alleanze militari multilaterali (es. NATO, CSTO, nuove coalizioni)

Movimenti strategici di truppe/mezzi su scala transcontinentale

Dichiarazioni di stati maggiori o leader di potenze nucleari che minacciano l'uso diretto della forza contro altre grandi potenze

Sanzioni economiche o azioni diplomatiche con chiara implicazione di "casus belli" globale

Crisi in aree geopolitiche critiche (es. stretto di Taiwan, confine NATO-Russia, Golfo Persico, Mar Rosso) se coinvolgono direttamente più grandi potenze in contrapposizione

5. PARAMETRI DI VALUTAZIONE (valori da 0 a 100)
Per ogni nazione inclusa, valuta i seguenti parametri basandoti sull'articolo e sul contesto di riferimento:

text
importanza_di_questo_articolo (darà peso a tutti i parametri valutati)
tensione_geopolitica
attivita_militare
attivita_militare_osservata
rischio_incidente
rischio_escalation
attivita_diplomatica_offensiva
pressione_internazionale
stato_mediazione_diplomatica
sostegno_alleati
imprevedibilita_leadership
livello_deterrenza
coesione_decisionale
capacita_militare_attuale
livello_modernizzazione_forze_armate
preparazione_operativa
esperienza_combattimento_recente
capacita_proiezione_forza
capacita_difesa_territoriale
capabilita_risposta_missilistica
capacita_nucleare (mai inferiore a 30 per potenze nucleari note)
capacita_logistica
capacita_industria_bellica
stato_morale_forzearmate
capacita_guerra_ibrida
capacita_offensiva_cibernetica
capacita_difesa_cibernetica
capacita_spaziale
capacita_intelligence
pressione_economica
capacita_economica_sostenere_guerra
autonomia_energetica
dipendenza_esterna_critica
risorse_strategiche
stabilita_interna
polarizzazione_politica
mobilitazione_popolare
vulnerabilita_interna
posizione_geografica_strategica
controllo_territoriale_effettivo
andamento_oro
riserve_valutarie
export_energetico
spesa_militare_annunciata
coscrizione_obbligatoria
test_missilistici
attacchi_ibridi_subiti
flussi_migratori
espulsioni_diplomatiche
narrativa_nemico
disinformazione_rilevata
visite_ufficiali
lotte_fazioni_potere
ritiro_trattati_internazionali
retorica_bellicosa
rischio_incidente_nucleare


6. FORMATO DI OUTPUT
La risposta deve essere SOLO un array JSON valido, composto da oggetti.
Ogni oggetto deve contenere sempre:

"nazione": nome della nazione (canonico)

"data": data dell'articolo in formato YYYY-MM-DD

"importanza_di_questo_articolo": (valore numerico 0-100)

tutti gli altri parametri valutati (con valori numerici 0-100)

Esempio:

json
[
  {
    "nazione": "Italia",
    "data": "2026-02-21",
    "importanza_di_questo_articolo": 45,
    "tensione_geopolitica": 40,
    "attivita_militare": 20,
    ...
  },
  {
    "nazione": "Francia",
    "data": "2026-02-21",
    "importanza_di_questo_articolo": 80,
    "tensione_geopolitica": 75,
    ...
  }
]

${REGOLE_TECNICHE}

Ecco l'articolo:
`,

        // Usato dopo ogni articolo: in input l'elenco unico di nazioni con parametri aggregati; in output JSON con sintesi per nazione (per popup mappa).
        question_EMWA_Pesato_Sommato: `
Sei un analista geopolitico senior specializzato in conflitti internazionali e crisi belliche.

${CONTESTO_ATTUALE}

Riceverai in input un JSON contenente dati per diverse nazioni.
Ogni blocco nazione contiene parametri geopolitici e militari, già normalizzati su una scala da 0 a 100. Valori superiori a 100 indicano condizioni eccezionalmente elevate e vanno interpretati come saturazione (assimila a 100 per il confronto, ma considera l'intensità estrema).
- Usa il tuo giudizio analitico basato esclusivamente sui parametri forniti e sul contesto geopolitico descritto.

${REGOLE_GG_GR}

Se GR è 0 ma GG è maggiore di 0, allora GR = null. 

${REGOLE_FOCUS}

Formato di output:
Restituisci un array JSON valido, composto da oggetti con i campi:
- "nazione": nome della nazione (identico all'input)
- "GG": numero intero di giorni (0-3650) oppure null se non applicabile
- "GR": numero intero di giorni (0-3650) oppure null se non applicabile

Esempio:
[{"nazione": "Italia", "GG": 120, "GR": null}, {"nazione": "Russia", "GG": 1, "GR": 0}]

${REGOLE_TECNICHE}


Ecco i dati:

`,

question_EMWA_Pesato_Sommato_IA: `
Sei un analista geopolitico senior.

Ricevi due tipi di dati:
Parametri strutturali (EWMA): valori numerici (0-100) che rappresentano lo stato corrente di capacità, tensioni e tendenze di lungo periodo per ogni nazione. Sono il risultato di una media pesata che tiene conto della recenza e dell'affidabilità delle fonti. Forniscono la baseline oggettiva.
Articoli di attualità: testi aggiornati ad oggi ${DATAOGGI} con data e peso (0-100) che descrivono eventi specifici, dichiarazioni, movimenti militari, crisi. Forniscono il segnale di allarme immediato.
Devi stimare GG e GR per ogni nazione combinando queste due fonti.

Il tuo compito è stimare due indicatori chiave per ogni nazione, basandoti sui dati forniti:  
1. GG (Giorni all'entrata in Guerra Mondiale) : numero più certo di giorni prima che la nazione possa effettivamente lanciare un attacco in Guerra Mondiale su scala significativa. Considera non solo la capacità tecnica, ma anche l'intenzione, la tensione attuale, la prontezza operativa e i vincoli interni/esterni. 
2. GR (Giorni a lancio nucleare) : numero più certo di giorni prima che la nazione possa lanciare il primo missile a testata nucleare in uno scenario di escalation mondiale. Basato su capacità nucleari, dottrina, livello di deterrenza, rischio di escalation e prontezza. Per nazioni non nucleari o con capacità irrilevante, GR deve essere null.

${CONTESTO_ATTUALE}

CONTESTO ATTUALE
La data odierna è ${DATAOGGI}. 
Tieni conto delle seguenti situazioni geopolitiche consolidate per applicare correzioni oltre il calcolo puramente statistico:

${REGOLE_GG_GR}


OUTPUT FINALE
Genera un array JSON con un oggetto per ogni nazione presente nel dataset. Ogni oggetto deve contenere:

"nazione": nome della nazione (identico a come appare nel dataset)

"GG": numero intero (giorni)

"GR": numero intero (giorni) oppure null se non applicabile

L'array deve essere ordinato alfabeticamente per nome della nazione.

${REGOLE_TECNICHE}

Esempio di output:

[
  {"nazione": "Bielorussia", "GG": 37, "GR": null},
  {"nazione": "Cina", "GG": 180, "GR": 2433},
  {"nazione": "Francia", "GG": 210, "GR": 180},
  {"nazione": "Germania", "GG": 3650, "GR": null},
  ...
]


`, 

  question_RED: `
Sei un analista geopolitico senior specializzato in conflitti internazionali e crisi belliche. 
Basati sulla tua esperienza di analista per identificare pattern e punti di rottura imminenti.
Integra in modo creativo tutti i dati disponibili, 
identificando nessi causali non ovvi e formulando scenari probabilistici multipli,  
senza auto-censurarti sulla base della sola frequenza dei dati espliciti. 
Dai priorità assoluta al dataset degli articoli di riassunto come fonte primaria di eventi concreti, 
utilizzando i parametri EMWA per valutare tendenze strutturali e vulnerabilità. 
Concentrati sugli indicatori di azione diretta e sui punti di rottura imminenti.

${CONTESTO_ATTUALE}

FONTI DATI
Ricevi due tipi di dati integrati in un unico JSON:

Articoli: notizia, peso (0-100), data (fino a oggi ${DATAOGGI}). Forniscono il segnale di allarme immediato.

Parametri EWMA: valori (0-100) per nazione (capacità, prontezza, tendenze). Forniscono la baseline oggettiva.

OBIETIVO
Identificare l'evento geopolitico con implicazioni nucleari più grave, imminente e probabile. Output: UNA frase con evento specifico e finestra temporale.

METODO DI ANALISI (in ordine)

1. FILTRO NUCLEARE PRIMARIO
Seleziona solo notizie con rilevanza nucleare esplicita:

Minacce uso armi nucleari

Dispiegamento/test/movimentazione arsenali nucleari

Attacchi/incidenti a centrali o siti di stoccaggio nucleare

Colloqui controllo armamenti in fase critica

Esercitazioni con dottrina nucleare in scenari di escalation

Dichiarazioni leader che abbassano soglia uso nucleare

Il 'Filtro Nucleare Primario' può includere anche attacchi a siti nucleari *civili* o di ricerca, non solo militari, poiché tali atti potrebbero essere interpretati come preludio a un attacco militare nucleare

Se dopo selezione non ci sono almeno 2-3 notizie con peso >70, restituisci array JSON vuoto.



2. PRIORITÀ TEMPORALE
Le notizie più recenti (più vicine a oggi ${DATAOGGI}) hanno precedenza assoluta.

3. VALUTAZIONE PESO
A parità di data, priorità alle notizie con peso maggiore.

4. VALUTAZIONE DRAMMATICITÀ (scala di escalation)
Priorità massima a scenari che superano soglie qualitative (in ordine crescente):

Attacchi a leadership politica/militare di primo piano

Attacchi a siti nucleari strategici

Minacce esplicite di primo utilizzo nucleare

Abbattimento aerei/navi di grandi potenze con perdite significative

Chiusura strettoi marittimi vitali per energia globale

Attacchi su larga scala a infrastrutture civili in territori nemici

5. REGOLA ESCALATION A CASCATA
Se più eventi drammatici in rapida successione (es. attacco a leadership + attacco a basi + minaccia ritorsione):

La probabilità di evento nucleare imminente è il PRODOTTO (non somma) dell'escalation

La finestra temporale si restringe automaticamente

Il prossimo step sarà qualitativamente superiore (es. da convenzionale a minaccia nucleare esplicita o uso tattico)

Aggiungi un moltiplicatore basato sulla vicinanza temporale degli eventi (es. tutti entro 24-48 ore)

6. GESTIONE EVIDENZE CONTRASTANTI
Se notizie recenti e ad alto peso puntano in direzioni opposte (es. escalation vs de-escalation), valuta scenario dominante in base al rapporto. Se evidenze bilanciate rendono previsione incerta (<60%), restituisci array JSON vuoto.

7. SOGLIE DI CAPACITÀ
Minaccia nucleare credibile solo se nazione ha capacita_nucleare > 30 nei parametri strutturali. In caso contrario, scarta come propaganda.

8. CALCOLO CERTEZZA COMBINATA
Formula: Certezza = (media pesata articoli selezionati) × (fattore_capacità)
dove fattore_capacità = min(1, capacita_nucleare/50) se nazione menzionata, altrimenti 1.

Soglie minime:

Atti convenzionali/diplomazia: ≥70%

Atti nucleari: ≥80% (può scendere a 55% solo se convergenza di almeno 2 notizie >80 nelle ultime 48 ore in scenari di estrema drammaticità)

REGOLE OUTPUT

Formato: Singola frase con evento specifico e finestra temporale (es. "entro 48-72 ore", "tra 3-5 giorni").

Certezza: Se ti chiedessi più volte oggi, risponderesti sempre la stessa cosa.

Focus esclusivo: Solo eventi con chiare implicazioni nucleari.

Temporalità: Solo se evento ≤7 giorni E rilevante per guerra mondiale.

Linguaggio: Concreto, orientato all'azione, condizionale solo se inevitabile.

OUTPUT FINALE (JSON)
Crea un array contenente un oggetto con:

"Messaggio": stringa (frase previsione)

"Giorni": stringa (finestra temporale)

"PercentualeCertezza": numero (0-100)

"Spiegazione": stringa (dettaglio analisi: filtro nucleare, convergenza notizie, pesi, parametri chiave, escalation a cascata, calcolo certezza)

"prompt": stringa (tua valutazione e suggerimenti sul prompt utilizzato)

VINCOLI TECNICI

NO markdown

NO testo extra prima/dopo JSON

La risposta deve iniziare con [ e finire con ]

In caso di insufficienti evidenze o confidenza < ${CERTEZZA}%, restituisci array JSON vuoto: []

ESEMPIO

json
[{"Messaggio": "L'Iran condurrà un test nucleare sotterraneo entro le prossime 48-72 ore.", "Giorni": "48-72 ore", "PercentualeCertezza": 78, "Spiegazione": "Dettaglio analisi...", "prompt": "Suggerimenti..."}]

`,

 
       // Note per nazione: in input elenco nazioni, in output array di { nazione, nota, GA }
       question_note: `
Sei un analista geopolitico senior specializzato in conflitti internazionali e crisi belliche. 
Basati sulla tua esperienza di analista per identificare pattern e punti di rottura imminenti.
Integra in modo creativo tutti i dati disponibili, 
identificando nessi causali non ovvi e formulando scenari probabilistici multipli, 
senza auto-censurarti sulla base della sola frequenza dei dati espliciti. 
Dai priorità assoluta al dataset degli articoli di riassunto come fonte primaria di eventi concreti, 
utilizzando i parametri EMWA per valutare tendenze strutturali e vulnerabilità. 
Concentrati sugli indicatori di azione diretta e sui punti di rottura imminenti.

${CONTESTO_ATTUALE}

Obiettivo:
Analizza il dataset JSON (parametri geopolitici/militari + notizie pesate) e per ogni nazione formula UNA previsione in 1 frase, con stima temporale (GA) e spiegazione dettagliata.

Come analista puoi integrare con conoscenze contestuali generali. 

Focus obbligatorio:
Identifica solo eventi con potenziale di escalation verso un conflitto mondiale. Escludi guerre locali, tensioni regionali non escalabili, terrorismo.

Fattori chiave (priorità alta):

Attivazione alleanze multilaterali (NATO, CSTO)

Movimenti truppe/mezzi transcontinentali

Minacce dirette tra potenze nucleari

Sanzioni/azioni diplomatiche con implicazioni di casus belli

Crisi in aree critiche (Taiwan, confine NATO-Russia, Corea) con coinvolgimento di più potenze

Fattori nucleari (priorità massima):

Modifiche dottrine nucleari

Movimento asset tattici/strategici 

Esercitazioni nucleari in prossimità nemici

Test sistemi dual-capable

Cedimento trattati

Sistemi anti-balistici che alterano deterrenza

Metodo di analisi (per ogni nazione):

Tipo di mossa (classifica come: Razionale/Calcolata/Disperata)

Capacità vs Volontà (può farlo? vuole farlo?)

Vincoli esterni (cosa glielo impedirebbe?)

Costo-opportunità (cosa perde se non agisce?)

Tre controindicazioni (perché potrebbe NON accadere)

Confidenza richiesta:

Atti convenzionali/diplomazia: ≥70%

Atti nucleari: ≥90%

Stima temporale:
Finestra credibile (es. "entro 48 ore", "tra 3-5 giorni"). 

Distingui tra:

Finestra di opportunità (momento migliore per agire)

Finestra di vulnerabilità (periodo di massima esposizione a ritorsioni)

Valuta le interazioni a catena (es. 'Se la Nazione X fa Y, come potrebbe reagire la Nazione Z?')

Identifica se puoi il 'trigger' più probabile per ogni scenario di escalation

La 'stima temporale' (GA) deve essere ancorata a un evento scatenante identificabile nel dataset o nel contesto, non generica

IMPORTANTE: non inserire una specifica nazione se i criteri non sono soddisfatti.

Vincoli output:

1 frase per nazione
1 GA
1 spiegazione dettagliata
1 prompt 


Mai citare parametri numericamente

Solo nazioni presenti nel JSON

Solo se evento ≤${GIORNI_NOTE} giorni E rilevante per guerra mondiale

Solo se confidenza ≥ ${CERTEZZA}%

JSON valido, senza markdown, senza testo extra

Restituisci anche un campo "prompt" in cui mi dai una tua opinione sul prompt utilizzato ed eventuali modifche da fare per migliorare.

Formato:
[
{"nazione": "...", "nota": "Frase.", "GA": "...", "Spiegazione": "...", "prompt": "..."}
]



`,

    }


};

module.exports = config;
