---
name: review
description: Reviewt einen Pull Request mit spezialisierten Reviewer-Subagenten auf einem eingefrorenen Diff-Bundle und platziert die Findings als Inline-Kommentare für einen Coding-Agent. Nutze diese Skill, wenn ein PR geprüft werden soll — etwa bei "review PR 55", "prüfe den Pull Request", "/pr_review 55".
---

# PR-Review

Argumente: `$ARGUMENTS`

Erlaubte Formen: `55` · `#55` · `55 --repo owner/name` · `55 --freeze` ·
`--bundle <pfad> --only <analyst>` · `55 --dry-run` · `55 --verify`

## Regeln, die nicht verhandelbar sind

- Du gibst **kein Approve** ab und löst **keinen Merge** aus. Das Review ist ein Signal.
- Du **änderst keinen Code**. Wer die Befunde behebt, ist eine andere Session — das
  ist Absicht und schützt vor Self-Preference-Bias.
- Du liest den Diff **nicht selbst** in deinen Kontext. Die CLI baut das Bundle, die
  Subagenten lesen es. Du orchestrierst.
- Du erfindest keine Befunde und schreibst keine Analysten-Findings selbst.

## Phase 0 — Aufsetzen

1. PR-Nummer aus `$ARGUMENTS` lesen, eine führende `#` entfernen. Fehlt sie **und ist
   `--bundle` nicht gesetzt**, frage nach.
2. Ist `--bundle` gesetzt, überspringe Phase 1 und nutze das angegebene Verzeichnis.
   **In diesem Fall brauchst du keine PR-Nummer** — Repo und Nummer stehen in der
   `meta.json` des Bundles, und die CLI liest sie von dort. Frage also nicht nach einer
   Nummer, wenn `--bundle` gesetzt ist.
3. Sonst: `pr-review fetch <nr>` (mit `--repo`, falls angegeben).

Die Ausgabe ist JSON mit `dir`, `files`, `changedLines`, `specLink`, `missingTests`,
`patchMissing`. **Lies nur diese Zusammenfassung**, nicht das Bundle.

Bricht `fetch` ab, gib die Meldung wörtlich an den Aufrufer weiter und höre auf.

**Bei `changedLines > 3000`:** frage den Aufrufer, ob trotzdem gelaufen werden soll.
Nenne dabei, dass diese Größe meist selbst der Befund ist — ein PR dieser Größe ist
nicht mehr reviewbar.

**Bei `--freeze`:** melde den Bundle-Pfad und höre hier auf.

## Phase 1 — Analysten auswählen

Ermittle die Analysten aus zwei Verzeichnissen:

- `<plugin>/analysts/*.md`
- `<repo>/.claude/pr-review-analysts/*.md` (gewinnt bei gleichem `name`)

Lies je Datei nur das Frontmatter und den Body. Wähle aus:

- `when: always` → läuft immer
- `when: paths` → läuft nur, wenn ein geänderter Pfad aus `meta.json` auf ein Glob
  aus `paths` passt

Bei `--only <name>` läuft genau dieser Analyst.

Nenne dem Aufrufer in einer Zeile, welche Analysten laufen und welche nicht (mit Grund).

## Phase 2 — Dispatch

Starte **alle** ausgewählten Analysten **in einer einzigen Nachricht** parallel, jeden
über den Agent-Typ `pr-review:pr-review-analyst`. **Der Name ist namespaced** — Plugin-
Agent-Typen heißen `<plugin>:<agent>`, und der unqualifizierte Name `pr-review-analyst`
existiert nicht. Am laufenden Plugin verifiziert. Der Auftrag je Analyst besteht aus
genau drei Blöcken, in dieser Reihenfolge, jeweils durch eine Leerzeile getrennt und
ohne zusätzliche Überschriften oder Vorwort von dir:

1. dem vollständigen Inhalt von `<plugin>/analyst-contract.md`
2. dem Body der Analystendatei
3. diesem Block:

```
Bundle: <bundle-pfad>
Dein Name: <analyst-name>
Schreibe deine Befunde nach <bundle-pfad>/findings/<analyst-name>.json
Lies ausschliesslich innerhalb des Bundle-Verzeichnisses.
```

Ist im Frontmatter ein `model` gesetzt, nutze es für diesen Subagenten.

Warte, bis alle fertig sind. Sammle **keine** Befundtexte in deinen Kontext — die
Subagenten schreiben Dateien, die CLI liest sie.

## Phase 3 und 4 — Aggregieren und platzieren

Ein Aufruf macht beides:

- normal: `pr-review post <nr>`
- mit `--dry-run`: `pr-review post <nr> --dry-run`
- beim Zweitlauf (`--verify`): `pr-review verify <nr>`

**Gib die in Phase 1 nicht gestarteten Analysten mit durch**, damit die Bilanz sie
nennt und niemand das Review für vollständiger hält als es ist:

```
pr-review post <nr> --skipped "java-spring:kein Pfad im Diff passt auf **/*.java"
```

**Und gib jeden Analysten durch, der ausgefallen ist** — der einen Fehler zurückgegeben
hat oder gar keine Datei geschrieben hat. Die CLI erkennt nur kaputtes JSON in einer
vorhandenen Datei; ein Subagent, der abgestürzt ist, ohne etwas zu schreiben, ist für sie
unsichtbar und würde in der Bilanz weder unter „gelaufen" noch unter „ausgefallen"
auftauchen. Dann behauptet das gepostete Review mehr Vollständigkeit als es hatte:

```
pr-review post <nr> --failed "security-context:Subagent hat keine Datei geschrieben"
```

Beide Flags nehmen `name:grund` und mehrere Einträge durch Komma getrennt.

**Die CLI prüft das nach.** Sie kennt alle Analystennamen und trägt jeden, der keine
Findings-Datei geschrieben hat und in keinem der beiden Flags steht, selbst als
ausgefallen in die Bilanz ein — mit dem Grund, dass er weder eine Datei geschrieben noch
gemeldet wurde. Das ist die Rückfalllinie, nicht der Regelweg: dein `--skipped`-Grund ist
für den Leser brauchbar, dieser hier sagt nur „unklar". Gib bei `--only <name>` also die
übrigen Analysten als `--skipped` mit, sonst stehen sie als ausgefallen in der Bilanz.

Die CLI validiert die Befunde, verwirft Erfundenes, clustert Überlappungen, hebt die
Severity bei Mehrfachbefunden, prüft jeden Zeilenanker gegen den Diff und postet
**einen** Review mit `event: COMMENT`.

## Phase 5 — Bilanz an den Aufrufer

Berichte kurz und in dieser Form:

- Befunde je Severity
- gelaufene, nicht gestartete und **ausgefallene** Analysten (Ausfälle immer namentlich)
- verworfene Befunde mit Grund
- ankerlose Befunde
- Link auf das Review
- beim Zweitlauf: „N behoben, M offen, K neu" — und **jeden Rückfall ausdrücklich**:
  ein Befund, dessen Thread schon einmal aufgelöst war und der wieder gemeldet wird, ist
  das Wichtigste, was ein Zweitlauf zu sagen hat. Die Zahl steht als `regressed` in der
  JSON-Ausgabe von `pr-review verify`.

Wenn ein Analyst ausgefallen ist, sage das deutlich. Ein Review, das stillschweigend
mit der Hälfte der Analysten gelaufen ist, ist schlimmer als ein sichtbar
unvollständiges.

Wenn alle Analysten ausgefallen sind, ist **nichts** gepostet worden. Sage das.
