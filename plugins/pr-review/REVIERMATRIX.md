# Reviermatrix — wem ein Konfliktort gehört

Entschieden am 14.08.2026 (0.14.0), auf Basis der drei Messläufe vom 13.08.
Die Grenzen des Rosters wurden paarweise geschrieben, während es wuchs, und hier
zum ersten Mal als Ganzes entschieden. **Diese Datei ist die eine Quelle** — die
Prompts spiegeln ihre Zeilen, Bundle B verteidigt sie mit Sonden
(`test/fixtures/make-bundle-b.mjs`), und `test/reviermatrix.test.mjs` hält alle
drei Seiten aneinander fest. Kein Analyst liest diese Datei: jeder Subagent sieht
nur den Kontrakt und seine eigene Analystendatei. Wer eine Zeile ändert, ändert
Prompt und Sonde im selben Schritt — der Spiegelungstest erzwingt es.

Zwei Klassen, ausdrücklich unterschieden:

- **Konfliktklassen (K):** genau ein Eigentümer. Regel-Doppelbesitz — dieselbe
  Regel, mehrfach gemeldet — war in den Messläufen die Quelle **aller** unechten
  Severity-Erhöhungen: Lauf 2 drei von vier, Lauf 3 die einzige.
- **Erwünschte Überlappungen (U):** zwei Blickrichtungen, zwei **verschiedene
  Aussagen**, ein Ort. Sie bleiben und dürfen durch keine Abgrenzung leiser
  werden. Zugesichert ist die Fund-Ebene, nicht das gemeinsame Cluster (Kopf von
  `make-bundle-b.mjs`).

---

## K1 — Präzedenzkette der Belegquellen

Wenn dieselbe Sache aus mehreren Quellen belegbar ist, gewinnt die **stärkste
tatsächlich tragende Quelle**, von oben geprüft:

| Stufe | Belegquelle | Eigentümer |
|---|---|---|
| 1 | ausdrückliche Regel in `conventions.md` | `spec-fidelity` |
| 2 | Muster der Nachbarschaft in `siblings/` — trägt erst ab **zwei** Sichtungen | `consistency` |
| 3 | Framework-Idiom, Mittel laut `manifests/` vorhanden | `java-spring` / `vue-ts` |

**Pflichten des Eigentümers auf Stufe 1:** die Regel wörtlich im `problem`, und
das konkrete Mittel im `fix`, wenn eines die Regel erfüllt (laut Manifest — etwa
`vue-i18n` für Übersetzungen). Der Kommentar darf die Framework-Konkretheit nicht
verlieren, die vorher der Stack-Analyst lieferte; das war das stärkste Argument
gegen diese Option, und die fix-Pflicht ist seine Milderung.

**Alle Abtretungs-Bedingungen zeigen auf Bundle-Inhalt** (`conventions.md`,
`siblings/`, `manifests/`), **nie auf das Roster** („gehört X, wenn er läuft").
Eine Roster-Bedingung wäre eine weiche Grenze — und weiche Grenzen haben in diesem
Projekt zweimal Löcher gerissen.

Belege (13.08.): `Result<T>`-Wurf in 3/3 Läufen von `consistency` **und**
`spec-fidelity` mit derselben Regel und demselben fix gemeldet, in Lauf 2 und 3
auf blocker erhöht; i18n-Literal in 3/3 Läufen von **drei** Analysten gemeldet —
ob die Erhöhung feuerte, hing nur daran, ob zwei zufällig dieselbe Severity
wählten (Lauf 2: ja, Lauf 3: nein).

Sonden: „Wurf gegen die geschriebene Result-Konvention" (muss `spec-fidelity`,
darfNicht `consistency`, `java-spring`) · „Sichtbares Literal gegen die
geschriebene i18n-Konvention" (muss `spec-fidelity`, darfNicht `consistency`,
`vue-ts`) · „Inline-Normalisierung neben dem Ids.normalize der Nachbarn" (Stufe 2:
muss `consistency`, darfNicht `java-spring`).

## K2 — Framework-Nachbau ohne geschriebene Regel

Eigentümer: der **Stack-Analyst** (`java-spring`, `vue-ts`) — er benennt das
Mittel und belegt es am Manifest. `consistency` tritt ab, wo das Vorhandene im
Framework liegt statt im Repo (ihm gehört weiter die eigene Hilfsfunktion neben
einer vorhandenen **im Repo**). `spec-fidelity` tritt am Nachbau-Ort **schmal**
ab: die Aussage „nie beauftragt" entfällt dort **bewusst** — sie duplizierte in
allen drei Läufen denselben Auftrag ohne das Mittel, und ihr fix („entfernen")
widersprach dem des Eigentümers („@Cacheable"). Dokumentierte Ausnahme in
`UEBERGABE-pr-review.md`, Abschnitt 3. Ungefragte Zusätze, die **kein** Nachbau
sind, bleiben `spec-fidelity`.

Beleg (13.08.): Eigenbau-Cache in 3/3 Läufen mehrfach gemeldet, in Lauf 2 dreifach
getaggt (`consistency` + `java-spring` + `spec-fidelity`) und auf blocker erhöht.

Sonde: „Eigener Cache statt @Cacheable" (muss `java-spring`, darfNicht
`consistency`, `spec-fidelity`).

**Nachgeschärft am 17.08.:** Die Grenze hängt am **Gegenstand**, nicht an der
Formulierung. Im Kalibrierungslauf unter dem Betriebs-Pin (opus-5/effort-low)
meldete `consistency` den Cache erneut — exakt am Sondenzitat, aber neu gerahmt
als „Musterabweichung von zustandslosen Nachbarn", ohne das Wort Nachbau. Der
Prompt trägt seither ausdrücklich: auch so gerahmt gehört eine Zustands-,
Zwischenspeicher- oder Ablauf-Schicht mit Framework-Baustein dem Stack-Analysten.

## K3 — Änderung ohne Bezug in CI-Dateien

Eigentümer: **`gate-integrity`, allein.** Die Abtretung von `spec-fidelity` läuft
**hart über den Dateipfad** (`.github/workflows/`, `.github/actions/`,
`action.yml`/`action.yaml`): dort meldet er nichts, auch keinen ungefragten
Zusatz. Der Anker des Eigentümers ist die `name:`-Zeile bzw. die erste geänderte
Zeile (vorgeschrieben seit 0.13.0).

**Bewusste Deckel-Folge, Teil dieser Entscheidung:** der Ort wird
**blocker-fähig** — `gate-integrity` deckelt bei blocker, wo `spec-fidelity` bei
major deckelte. Gewollt: ein Workflow ohne Auftrag ist eine angetastete
Prüfschicht, kein Spec-Thema.

Beleg (13.08.): `spec-fidelity` meldete den Release-Workflow in Lauf 1 und 3 als
„ohne Bezug" — in Lauf 1 auf genau der `name:`-Zeile, die der Landkarten-Eintrag
`gate-integrity` vorschreibt.

Sonde: „Neuer CI-Workflow ohne Bezug zum PR-Inhalt" (muss `gate-integrity`,
Anker `name:`, darfNicht `spec-fidelity`).

---

## U — Erwünschte Überlappungen

| Zeile | Ort | Blickrichtungen (je eigene Aussage) |
|---|---|---|
| U1 | History-Endpunkt ohne Autorisierung | `security-context` (offener Weg, Vergleichsfall im Diff) + `spec-fidelity` (Kriterium 2 unerfüllt) + `test-substance` (nur Erreichbarkeitstest — beobachtet, nicht gepflanzt) |
| U2 | `pull_request_target` mit Fork-Checkout | `workflow-ci` (Auslöser samt Checkout) + `security-context` (geöffneter Weg) — die gepflanzte Überlappung |
| U3 | dieselbe Zeile „anders" und „unerklärt" | `consistency` (anders als die Nachbarn) + `rationale` (Warum fehlt) |
| U4 | dieselbe Zeile „Nachbau" und „unerklärt" (Deep-Watch, Lauf 3) | `java-spring`/`vue-ts` (Nachbau statt Framework-Mittel) + `rationale` (Umweg unbegründet) — **erlaubt, nicht zugesichert**: kein muss, keine Sonde. Die 4500-Sonde sperrte `java-spring` dort bis 17.08. aus — sie war älter als diese Zeile und wurde an sie angeglichen |

Der Unterschied zu K: hier stehen zwei **verschiedene** Aussagen mit zwei
verschiedenen Aufträgen am selben Ort. Verschmelzen sie über ein geteiltes Zitat,
ist das ein echtes Mehrfachbetroffenheits-Signal — genau das, was die Erhöhung
messen soll. Anmerkung zur Erhöhung: seit der Konkordanz-Regel kann U1 keine
Erhöhung mehr auslösen (Deckel blocker vs. major stimmen nie überein); bei U2
bliebe eine Konkordanz auf blocker ohne sichtbare Erhöhung (blocker ist das Dach).

Beobachtet im Abnahme-Messlauf 0.14.0 (14.08.), gleiche Bauart wie U1, keine
eigene Zeile: `spec-fidelity` (Kriteriums-Verletzung im **Verhalten** —
„Gesamtsumme zeigt beim ersten Rendern 0") und `vue-ts` (Nachbau — „watch statt
computed") verschmolzen über das geteilte watch-Zitat und erhöhten konkordant auf
blocker. Zwei Aussagen, zwei Rechte, eine Ursache: erwünscht. Kein muss, keine
Sonde — wie U4 erlaubt, nicht zugesichert.

## E — Bereits entschiedene Grenzen (Vollständigkeit)

- **Abwesenheit ohne eigenen Anker** (fehlende Testdatei, `missing_tests`): gehört
  der **Bilanz**, keinem Analysten. Sonden halten `gate-integrity` und
  `test-substance` fest. Entschieden mit Befund 4 (13.08.).
- **Fehlende Spec (`spec_missing`)**: dieselbe Regel, dritter Fall — gehört der
  **Bilanz** („Lücken in der Eingabe"), nicht `spec-fidelity`. Er arbeitet ohne
  Spec gegen `conventions.md` weiter und erfindet keine Kriterien. Entschieden am
  17.08. (Betreiber-Messung 14.08.: fünf echte PRs, fünfmal derselbe
  verankerte major mit dekorativem Zitat — die einzige major-Quelle der Runde).
- **`${{ }}`-Interpolation in `run:`-Blöcken**: gehört **actionlint** (Werkzeug).
  Sonden halten `workflow-ci` und `security-context` fest.
- **Rechte-Hygiene ohne geöffneten Weg** (`permissions: write-all`, ungepinnte
  Actions): `workflow-ci` allein; Sonde hält `gate-integrity` fest.
- **Testqualität vs. Wegnahme**: was dasteht und nicht prüft → `test-substance`;
  was verschwunden oder stummgeschaltet ist → `gate-integrity`. Unverändert.

## Option C — geprüft und verworfen

„Doppelbesitz bleibt, nur das Signal wird bereinigt" (die Erhöhung zählt bekannte
Doppelbesitz-Paare nicht mit) wurde am 14.08.2026 **verworfen**: es repariert die
Statistik statt der Ursache, kostet weiter dreifache Analysearbeit am selben Ort
und braucht eine Änderung an der Aggregationslogik. Hier dokumentiert, damit die
Entscheidung **dagegen** nachlesbar bleibt und niemand sie in einem Jahr erneut
vorschlägt.
