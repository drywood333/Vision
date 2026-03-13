import csv
import os
import shutil


INPUT_PATH = os.path.join(os.path.dirname(__file__), "Avira.csv")
BACKUP_PATH = os.path.join(os.path.dirname(__file__), "Avira_before_filter.csv")
MAX_FIELD_LEN = 1000


def main():
    if not os.path.exists(INPUT_PATH):
        raise SystemExit(f"File non trovato: {INPUT_PATH}")

    # Backup una sola volta, se non esiste già
    if not os.path.exists(BACKUP_PATH):
        shutil.copy2(INPUT_PATH, BACKUP_PATH)

    with open(INPUT_PATH, "r", encoding="utf-8", newline="") as f:
        reader = csv.reader(f)
        rows = list(reader)

    if not rows:
        raise SystemExit("Avira.csv è vuoto.")

    header = rows[0]
    kept_rows = [header]
    removed_count = 0

    for row in rows[1:]:
        # Se QUALSIASI campo supera MAX_FIELD_LEN, scarta l'intera riga
        too_long = False
        for cell in row:
            if cell is not None and len(str(cell)) > MAX_FIELD_LEN:
                too_long = True
                break
        if too_long:
            removed_count += 1
            continue
        kept_rows.append(row)

    with open(INPUT_PATH, "w", encoding="utf-8", newline="") as f:
        writer = csv.writer(f)
        writer.writerows(kept_rows)

    print(f"Righe originali: {len(rows) - 1}, rimosse: {removed_count}, mantenute: {len(kept_rows) - 1}")


if __name__ == "__main__":
    main()

