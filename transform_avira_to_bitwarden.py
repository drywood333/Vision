import csv
import io
import os
import shutil


INPUT_PATH = os.path.join(os.path.dirname(__file__), "Avira.csv")
BACKUP_PATH = os.path.join(os.path.dirname(__file__), "Avira_original.csv")


def main():
    if not os.path.exists(INPUT_PATH):
        raise SystemExit(f"File non trovato: {INPUT_PATH}")

    # Leggi tutte le righe originali, rimuovendo eventuali byte NUL
    with open(INPUT_PATH, "rb") as f:
        raw = f.read()
    if b"\x00" in raw:
        raw = raw.replace(b"\x00", b"")
    text = raw.decode("utf-8", errors="replace")
    reader = csv.reader(io.StringIO(text))
    rows = list(reader)

    if not rows:
        raise SystemExit("Avira.csv è vuoto.")

    header = rows[0]
    expected_header = ["name", "website", "username", "secondary_username", "password", "notes"]
    if [h.strip() for h in header] != expected_header:
        raise SystemExit(f"Header Avira.csv inatteso: {header} (atteso: {expected_header})")

    # Backup una sola volta, se non esiste già
    if not os.path.exists(BACKUP_PATH):
        shutil.copy2(INPUT_PATH, BACKUP_PATH)

    # Header Bitwarden (copiato da bitwarden.csv di esempio)
    bw_header = [
        "folder",
        "favorite",
        "type",
        "name",
        "notes",
        "fields",
        "reprompt",
        "login_uri",
        "login_username",
        "login_password",
        "login_totp",
    ]

    out_rows = [bw_header]

    for row in rows[1:]:
        # Garantisce lunghezza 6
        row = (row + [""] * 6)[:6]
        name, website, username, secondary_username, password, notes = row

        name = (name or "").strip()
        website = (website or "").strip()
        username = (username or "").strip()
        secondary_username = (secondary_username or "").strip()
        password = (password or "").strip()
        notes = (notes or "").strip()

        # Nome voce: se manca name, usa website
        entry_name = name or website or ""

        # Notes: mantieni note originali, eventualmente aggiungi secondary_username
        final_notes = notes
        if secondary_username:
            extra = f"Secondary username: {secondary_username}"
            final_notes = f"{notes}\n{extra}" if notes else extra

        # Nessuna folder, nessun TOTP, nessun reprompt
        folder = ""
        favorite = "0"
        entry_type = "login"
        fields = ""  # si potrebbe usare per info extra, ma per ora lasciamo vuoto
        reprompt = "0"
        login_uri = website
        login_username = username
        login_password = password
        login_totp = ""

        out_rows.append([
            folder,
            favorite,
            entry_type,
            entry_name,
            final_notes,
            fields,
            reprompt,
            login_uri,
            login_username,
            login_password,
            login_totp,
        ])

    # Sovrascrivi Avira.csv con il formato compatibile Bitwarden
    with open(INPUT_PATH, "w", encoding="utf-8", newline="") as f:
        writer = csv.writer(f)
        writer.writerows(out_rows)


if __name__ == "__main__":
    main()

