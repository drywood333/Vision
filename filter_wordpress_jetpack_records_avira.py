import csv
import os
import shutil


INPUT_PATH = os.path.join(os.path.dirname(__file__), "Avira.csv")
BACKUP_PATH = os.path.join(os.path.dirname(__file__), "Avira_before_filter_wordpress.csv")
TARGET_SUBSTRING = "https://wordpress.com/jetpack/connect/authorize/"


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
        text = ",".join("" if c is None else str(c) for c in row)
        if TARGET_SUBSTRING in text:
            removed_count += 1
            continue
        kept_rows.append(row)

    with open(INPUT_PATH, "w", encoding="utf-8", newline="") as f:
        writer = csv.writer(f)
        writer.writerows(kept_rows)

    print(f"Righe originali: {len(rows) - 1}, rimosse: {removed_count}, mantenute: {len(kept_rows) - 1}")


if __name__ == "__main__":
    main()

